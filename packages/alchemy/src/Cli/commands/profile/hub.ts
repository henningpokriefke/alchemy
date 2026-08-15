import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { defaultProfileName, ProfileStore } from "../../../Auth/Profile.ts";
import * as CliKit from "../../../Cli/CliKit/index.ts";
import { resolveProfileName } from "../../../Cli/ProfileSelection.ts";

import { isPromptCancellation, resolveProfileDisplay } from "../_shared.ts";
import {
  applyRename,
  collectAuthProviders,
  editProfileFlow,
  refreshProfileFlow,
  removeProfileWithCredentials,
} from "./flows.ts";

/**
 * The interactive hub behind bare `alchemy profile`: pick a profile (or
 * create one), then act on it. Every action delegates to the same flow the
 * corresponding subcommand runs, so the hub is purely a discovery layer.
 *
 * Prompt cancellation (Esc / Ctrl+C inside a nested prompt) backs out one
 * level instead of aborting the whole session; cancelling a top-level menu
 * exits the hub.
 */
export const profileHub = Effect.fn(function* (options: {
  envFile: Option.Option<string>;
  main: string;
}) {
  const { envFile, main } = options;
  const profiles = yield* ProfileStore;

  // Alphabetical — matches the tab order.
  const computeEntries = Effect.gen(function* () {
    const manifest = yield* profiles.readManifest;
    const activeProfile = yield* resolveProfileName(envFile, undefined);
    const defaultProfile = defaultProfileName(manifest);
    return Object.keys(manifest.profiles)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        isActive: name === activeProfile,
        isDefault: name === defaultProfile,
      }));
  });
  let lastEntries: ReadonlyArray<{
    name: string;
    isActive: boolean;
    isDefault: boolean;
  }> = [];

  // The store guarantees the default profile exists, so the dashboard
  // always has at least one row to land on.
  const { runProfileDashboardSession } = yield* Effect.promise(
    () => import("../../views/ProfileDashboard.tsx"),
  );
  const entries = yield* computeEntries;
  lastEntries = entries;

  // The session owns the terminal until the user quits; pure actions and
  // edit/refresh flows all share CliKit's application frame.
  yield* runProfileDashboardSession({
    entries,
    // Land on the last acted-on profile, else the active one.
    selected: entries.find((entry) => entry.isActive)?.name,
    loadDetails: (name) =>
      Effect.gen(function* () {
        // Read fresh — profiles can be created/renamed mid-session.
        const latest = yield* profiles.readManifest;
        const stored = latest.profiles[name]?.providers ?? {};
        const authProviders = yield* collectAuthProviders({
          main,
          envFile,
          profile: name,
        });
        const providers = yield* resolveProfileDisplay(
          name,
          stored,
          authProviders,
        );
        const available = Object.keys(authProviders)
          .filter((provider) => stored[provider] == null)
          .sort();
        return { providers, available };
      }).pipe(
        Effect.catch((e) =>
          Effect.succeed({
            providers: [
              {
                name: "error",
                method: "",
                status: "error" as const,
                lines: [e.message],
              },
            ],
            available: [],
          }),
        ),
      ),
    execute: (action) =>
      Effect.gen(function* () {
        switch (action.kind) {
          case "create": {
            yield* profiles.createProfile(action.name);
            return {
              message: `Created profile '${action.name}'.`,
              selected: action.name,
            };
          }
          case "rename": {
            const newName = yield* applyRename(action.name, action.newName);
            return {
              message: `Renamed '${action.name}' to '${newName}'.`,
              selected: newName,
            };
          }
          case "set-default": {
            yield* profiles.setDefaultProfile(action.name);
            return {
              message: `Default profile set to '${action.name}'.`,
              selected: action.name,
            };
          }
          case "delete": {
            yield* removeProfileWithCredentials(action.name);
            return {
              message: `Deleted '${action.name}' and its credentials.`,
              selected: undefined,
            };
          }
        }
      }).pipe(
        Effect.flatMap(({ message, selected: focus }) =>
          computeEntries.pipe(
            Effect.map((entries) => {
              lastEntries = entries;
              return { ok: true, message, entries, selected: focus };
            }),
          ),
        ),
        Effect.catch((e) =>
          Effect.succeed({
            ok: false,
            message: e.message,
            entries: lastEntries,
          }),
        ),
      ),
    runFlow: (action) =>
      Effect.gen(function* () {
        if (action.kind === "edit-apply") {
          const outcomes = yield* editProfileFlow({
            selectedProfile: action.name,
            add: action.add,
            reconfigure: action.reconfigure,
            remove: action.remove,
            envFile,
            main,
            printSummary: false,
            continueOnError: true,
          });
          // The toast reports what actually happened per provider — never
          // a blanket "updated" over a failed or cancelled step.
          const verb = (o: (typeof outcomes)[number]) =>
            o.outcome === "done"
              ? o.action === "add"
                ? "added"
                : o.action === "remove"
                  ? "removed"
                  : "updated"
              : o.outcome === "skipped"
                ? "skipped"
                : `failed: ${o.message}`;
          const failed = outcomes.some((o) => o.outcome === "failed");
          const changed = outcomes.some((o) => o.outcome === "done");
          return {
            ok: !failed,
            message:
              outcomes.length === 0
                ? "No changes."
                : failed || !changed
                  ? outcomes.map((o) => `${o.provider} ${verb(o)}`).join("; ")
                  : outcomes.every((o) => o.outcome === "done")
                    ? "Accounts updated."
                    : outcomes
                        .map((o) => `${o.provider} ${verb(o)}`)
                        .join("; "),
          };
        }
        yield* refreshProfileFlow({
          selectedProfile: action.name,
          providers: [],
          envFile,
          main,
        });
        return { ok: true, message: "Credentials refreshed." };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            isPromptCancellation(error)
              ? { ok: true, message: "Cancelled." }
              : { ok: false, message: error.message },
          ),
        ),
      ),
    reloadEntries: computeEntries.pipe(
      Effect.map((entries) => {
        lastEntries = entries;
        return entries;
      }),
      Effect.catch(() => Effect.succeed(lastEntries)),
    ),
  });
});
