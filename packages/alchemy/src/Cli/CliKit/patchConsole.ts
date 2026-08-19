import { Console } from "node:console";
import { Writable } from "node:stream";

const methods = [
  "assert",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "warn",
] as const;

/** Route console output to a callback until the returned restore runs. */
export const patchConsole = (
  write: (stream: "stdout" | "stderr", data: string) => void,
) => {
  const sink = (stream: "stdout" | "stderr") =>
    new Writable({
      write(chunk, _encoding, done) {
        write(stream, chunk.toString());
        done();
      },
    });
  const replacement = new Console(sink("stdout"), sink("stderr"));
  const originals = methods.map((method) => Reflect.get(console, method));
  methods.forEach((method) =>
    Reflect.set(console, method, Reflect.get(replacement, method)),
  );
  return () =>
    methods.forEach((method, index) =>
      Reflect.set(console, method, originals[index]),
    );
};
