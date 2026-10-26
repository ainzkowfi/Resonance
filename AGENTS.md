This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Branching — `main` is the only branch

`main` is the single long-lived branch, the default branch, and the only branch on `origin`. There is no `master` branch.

- Land finished work on `main` and push it to `origin/main`. Do not open feature branches, pull requests, or ask which branch to use.
- The `freebuff/<chat-id>` branch is a per-chat scratch worktree. When a task is finished, the result belongs on `main` — a commit sitting only on that branch has not been delivered.
- `ci.yml` (typecheck, lint, unit checks) and `build-android.yml` (release APK) both trigger on pushes to `main` and `v*` tags. If a workflow does not fire, its `on:` filter has drifted from the branch name — fix the filter, do not rename the branch.
- Verify a push actually landed by comparing `HEAD` with `FETCH_HEAD` after fetching; this clone has no remote-tracking refs configured.

## Audit Rules

- **Always re-evaluate every finding to filter out false positives** before reporting. Verify each issue against the actual code behavior.
- **Never commit, push, or make changes without explicit permission.** Always list what needs to be changed first and ask for approval.
- When reporting issues, categorize them by severity and provide clear evidence from the code.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
