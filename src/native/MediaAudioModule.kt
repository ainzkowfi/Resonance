package com.resonance.app

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Device-side audio decoding, replacing ffmpeg-expo.
 *
 * One job is exported: decode the first `maxSeconds` of a track into a mono
 * 16-bit little-endian WAV at `targetRate` — the shape the JS analysis pipeline
 * (waveform peaks, loudness leveling, silence bounds) already expects. MediaCodec
 * supplies the decoder, a box-average downsample produces the resampling, and the
 * WAV container is written by hand from 44 bytes of header, mirroring the test
 * WAV that `src/lib/decodeCheck.ts` builds.
 *
 * Failures throw, so JavaScript sees them as rejected promises and can record
 * the message. The matching loader lives in `src/media/module.ts`.
 */
class MediaAudioModule : Module() {
  override fun definition() = ModuleDefinition {
    AsyncFunction("decodeToWav") Coroutine { sourcePath: String, outputPath: String, targetRate: Int, maxSeconds: Int ->
      decode(sourcePath, outputPath, targetRate, maxSeconds)
      true
    }

    Function("listDecoders") { codecNames(encoders = false) }

    Function("listEncoders") { codecNames(encoders = true) }
  }

  /**
   * Generous safety net. There is no JS-side cancel, so a pathological codec
   * must end itself instead of leaving a promise stuck until app death.
   */
  private val decodeBudgetMs = 60_000L

  private fun decode(sourcePath: String, outputPath: String, targetRate: Int, maxSeconds: Int) {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      extractor.setDataSource(sourcePath)

      var mime: String? = null
      var audioTrack = -1
      for (track in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(track)
        val type = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (type.startsWith("audio/")) {
          mime = type
          audioTrack = track
          break
        }
      }
      if (audioTrack < 0) throw IllegalArgumentException("No audio track in $sourcePath")
      extractor.selectTrack(audioTrack)
      val format = extractor.getTrackFormat(audioTrack)
      val sourceRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      val decoder = MediaCodec.createDecoderByType(mime!!)
      codec = decoder
      decoder.configure(format, null, null, 0)
      decoder.start()

      var resampler = BoxResampler(sourceRate, targetRate)
      val deadline = SystemClock.elapsedRealtime() + decodeBudgetMs
      val info = MediaCodec.BufferInfo()
      var sawInputEOS = false
      var sawOutputEOS = false
      var encoding = AudioFormat.ENCODING_PCM_16BIT
      // What the decoder claims it emits, which is not always what the track
      // format says: HE-AAC decodes at twice the rate the extractor reports.
      var decodeRate = sourceRate
      var outputChannels = channels
      var sourceFrames = 0L

      while (!sawOutputEOS) {
        if (SystemClock.elapsedRealtime() > deadline) {
          throw IllegalStateException("Decoding $sourcePath exceeded the ${decodeBudgetMs / 1000}s budget")
        }

        if (!sawInputEOS) {
          val inputIndex = decoder.dequeueInputBuffer(10_000L)
          if (inputIndex >= 0) {
            val input = decoder.getInputBuffer(inputIndex)
              ?: throw IllegalStateException("Codec returned no input buffer")
            val size = extractor.readSampleData(input, 0)
            if (size < 0) {
              decoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              sawInputEOS = true
            } else {
              decoder.queueInputBuffer(inputIndex, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        while (true) {
          val outputIndex = decoder.dequeueOutputBuffer(info, 10_000L)
          if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            // KEY_PCM_ENCODING is only knowable once the codec commits to an
            // output format; before that it is not present on outputFormat.
            // The same commit can change the rate and channel count, and a
            // resampler built from the track format would then mis-measure.
            val outputFormat = decoder.outputFormat
            if (outputFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
              encoding = outputFormat.getInteger(MediaFormat.KEY_PCM_ENCODING)
            }
            if (outputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
              outputChannels = outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            }
            if (outputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
              val rate = outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
              if (rate != decodeRate) {
                decodeRate = rate
                resampler = BoxResampler(decodeRate, targetRate)
              }
            }
            continue
          }
          if (outputIndex < 0) break // INFO_TRY_AGAIN_LATER: input needed or stream drained

          val output = decoder.getOutputBuffer(outputIndex)
            ?: throw IllegalStateException("Codec returned no output buffer")
          if (encoding != AudioFormat.ENCODING_PCM_16BIT && encoding != AudioFormat.ENCODING_PCM_FLOAT) {
            throw IllegalStateException("Unsupported PCM encoding $encoding from $mime decoder")
          }
          val mono = downmixToMonoShorts(output, encoding == AudioFormat.ENCODING_PCM_FLOAT, outputChannels)
          resampler.feed(mono)
          sourceFrames += mono.size
          val ended = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
          decoder.releaseOutputBuffer(outputIndex, false)
          if (ended || sourceFrames >= maxSeconds.toLong() * decodeRate) {
            sawOutputEOS = true
            break
          }
        }
      }

      val pcm = resampler.finish()
      if (pcm.size < 16) {
        throw IllegalStateException("Decode produced no audio ($sourceFrames source frames from $sourcePath)")
      }
      writeWav(File(outputPath), targetRate, pcm)
    } finally {
      try {
        codec?.stop()
        codec?.release()
      } catch (_: Exception) {
        // Release is best effort on a failure path.
      }
      extractor.release()
    }
  }

  private fun codecNames(encoders: Boolean): List<String> {
    val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    return list.codecInfos.filter { it.isEncoder == encoders }.map { it.name }
  }

  private fun downmixToMonoShorts(buffer: ByteBuffer, floatEncoding: Boolean, channels: Int): ShortArray {
    val littleEndian = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    if (floatEncoding) {
      val floats = littleEndian.asFloatBuffer()
      val frames = floats.remaining() / channels
      val mono = ShortArray(frames)
      val frame = FloatArray(channels)
      for (frameIndex in 0 until frames) {
        floats.get(frame)
        var total = 0f
        for (value in frame) total += value
        mono[frameIndex] = (((total / channels) * 32767f).toInt().coerceIn(-32768, 32767)).toShort()
      }
      return mono
    }

    val samples = littleEndian.asShortBuffer()
    val frames = samples.remaining() / channels
    val mono = ShortArray(frames)
    val frame = ShortArray(channels)
    for (frameIndex in 0 until frames) {
      samples.get(frame)
      var total = 0
      for (value in frame) total += value
      mono[frameIndex] = (total / channels).toShort()
    }
    return mono
  }

  private fun writeWav(target: File, rate: Int, pcm: ByteArray) {
    val header = ByteArray(44)
    fun writeInt32(offset: Int, value: Int) {
      header[offset] = (value and 0xFF).toByte()
      header[offset + 1] = ((value shr 8) and 0xFF).toByte()
      header[offset + 2] = ((value shr 16) and 0xFF).toByte()
      header[offset + 3] = ((value shr 24) and 0xFF).toByte()
    }
    fun writeTag(offset: Int, tag: String) {
      tag.forEachIndexed { index, char -> header[offset + index] = char.code.toByte() }
    }

    val size = pcm.size
    writeTag(0, "RIFF")
    writeInt32(4, 36 + size)
    writeTag(8, "WAVE")
    writeTag(12, "fmt ")
    writeInt32(16, 16)
    writeInt32(20, 1)
    writeInt32(22, 1)
    writeInt32(24, rate)
    writeInt32(28, rate * 2)
    writeInt32(32, 2)
    writeInt32(34, 16)
    writeTag(36, "data")
    writeInt32(40, size)

    FileOutputStream(target).use { stream ->
      stream.write(header)
      stream.write(pcm)
    }
  }

  /**
   * Box-average downsampler for a mono stream at the source rate.
   *
   * Each output frame averages the source samples that fall inside its window
   * of `sourceRate / targetRate` samples, with fractional windows split between
   * neighbouring frames. Averaging low-passes on the way down, which reads better
   * than nearest-neighbour picking for peaks and RMS, and it streams: one sample
   * travels through, only sums accumulate.
   */
  private class BoxResampler(sourceRate: Int, targetRate: Int) {
    /** Window width in source samples; >= 1, because decoding < 8 kHz audio buys nothing here. */
    private val step = sourceRate.toDouble() / targetRate
    private val out = ByteArrayOutputStream()
    private var cursor = 0.0 // absolute source position after the last consumed sample
    private var frameStart = 0.0 // start of the output frame being accumulated
    private var sum = 0.0
    private var weight = 0.0

    init {
      if (sourceRate < targetRate) {
        // step < 1 would need an upsampling loop this class does not implement;
        // every format ExoPlayer-level decoders emit for analysis is >= 8 kHz.
        throw IllegalArgumentException("Sample rate $sourceRate is below the target $targetRate")
      }
    }

    fun feed(source: ShortArray) {
      for (value in source) {
        val start = cursor
        val end = cursor + 1.0
        cursor = end
        var segmentStart = start
        while (segmentStart < frameStart + step) {
          val segmentEnd = minOf(end, frameStart + step)
          if (segmentEnd > segmentStart) {
            sum += value * (segmentEnd - segmentStart)
            weight += segmentEnd - segmentStart
          }
          if (segmentEnd >= frameStart + step) {
            emit(sum / step)
            // Each output frame starts empty. Without this reset the sums keep
            // every sample since the start of the stream, so the second frame
            // onwards is a running total and clips to full scale.
            sum = 0.0
            weight = 0.0
            frameStart += step
          }
          if (segmentEnd >= end) break
          segmentStart = segmentEnd
        }
      }
    }

    /** Flushes the final partial frame at end of stream. */
    fun finish(): ByteArray {
      if (weight > 0.0) {
        emit(sum / weight)
        sum = 0.0
        weight = 0.0
      }
      return out.toByteArray()
    }

    private fun emit(value: Double) {
      val rounded = value.toInt().coerceIn(-32768, 32767)
      out.write(rounded and 0xFF)
      out.write((rounded shr 8) and 0xFF)
    }
  }
}
