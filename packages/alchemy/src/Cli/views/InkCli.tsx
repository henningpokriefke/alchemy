/** @jsxImportSource react */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Plan } from "../../Plan.ts";
import { type PlanStatusSession, Cli } from "../Cli.ts";
import { Box } from "../CliKit/components.ts";
import { CliKit } from "../CliKit/index.ts";
import type { ApplyEvent } from "../Event.ts";
import { approvePlanScreen } from "./ApprovePlan.tsx";
import { Plan as PlanComponent } from "./Plan.tsx";
import { PlanProgress, PlanProgressStore } from "./PlanProgress.tsx";

export const inkCLI = () =>
  Layer.effect(
    Cli,
    Effect.map(CliKit, (cli) =>
      Cli.of({
        approvePlan: (plan) => approvePlan(cli, plan),
        displayPlan: (plan) => displayPlan(cli, plan),
        startApplySession: (plan) => startApplySession(cli, plan),
      }),
    ),
  );

const approvePlan = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
) {
  return yield* cli.prompt.custom(approvePlanScreen(plan)).pipe(
    Effect.catchTag("TerminalCancelled", () => Effect.succeed(false)),
    Effect.orDie,
  );
});

const displayPlan = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
) {
  // Plan carries no outer margin of its own; give the printed plan the same
  // breathing room the approval screen adds.
  yield* cli.output.print(
    <Box marginTop={1}>
      <PlanComponent plan={plan} />
    </Box>,
  );
});

const startApplySession = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
) {
  const progress = new PlanProgressStore(plan);
  // The session outlives this effect — the caller settles it via `done` on
  // every exit path (Apply.ts's onExit). live.open is Scope-bound, so give
  // it a manually managed scope that `done` closes; Apply deliberately runs
  // the session in the ambient scope, so we cannot lean on Effect.scoped
  // here.
  const scope = yield* Scope.make();
  const live = yield* cli.live
    .open(<PlanProgress store={progress} />, { persistOnClose: true })
    .pipe(Scope.provide(scope));
  return {
    done: (outcome) =>
      Effect.sync(() => progress.finish(outcome)).pipe(
        Effect.andThen(live.close),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      ),
    emit: (event: ApplyEvent) => Effect.sync(() => progress.emit(event)),
  } satisfies PlanStatusSession;
});
