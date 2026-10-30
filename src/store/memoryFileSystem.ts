import { ByteSize, Effect, FileSystem, Layer, Option, PlatformError } from "effect";

/**
 * An in-memory `FileSystem` for tests: every operation is synchronous, so a test under
 * `TestClock` never races real IO. Covers what `Store` and the recorder use, nothing more.
 */
export interface MemoryFiles {
  readonly files: Map<string, Uint8Array>;
  readonly layer: Layer.Layer<FileSystem.FileSystem>;
  /** While set, every write fails as a full disk would. */
  failWrites: boolean;
  /** The next write stores the first half of its bytes, then fails, as a crash mid-write would. */
  tearNextWrite: boolean;
}

const fail = (method: string, path: string, tag: "NotFound" | "Unknown" = "NotFound") =>
  PlatformError.systemError({ _tag: tag, module: "FileSystem", method, pathOrDescriptor: path });

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export const memoryFileSystem = (): MemoryFiles => {
  const files = new Map<string, Uint8Array>();
  const flags = { failWrites: false, tearNextWrite: false };
  const write = (method: string, path: string, data: Uint8Array, append: boolean) =>
    Effect.suspend(() => {
      if (flags.failWrites) return Effect.fail(fail(method, path, "Unknown"));
      const before = append ? (files.get(path) ?? new Uint8Array()) : new Uint8Array();
      if (flags.tearNextWrite) {
        flags.tearNextWrite = false;
        files.set(path, concat(before, data.subarray(0, data.length >> 1)));
        return Effect.fail(fail(method, path, "Unknown"));
      }
      files.set(path, concat(before, data));
      return Effect.void;
    });
  const fs = FileSystem.makeNoop({
    access: (path) =>
      files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`))
        ? Effect.void
        : Effect.fail(fail("access", path)),
    exists: (path) =>
      Effect.sync(() => files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`))),
    makeDirectory: () => Effect.void,
    readFile: (path) => {
      const data = files.get(path);
      return data === undefined ? Effect.fail(fail("readFile", path)) : Effect.succeed(data);
    },
    readFileString: (path) => {
      const data = files.get(path);
      return data === undefined
        ? Effect.fail(fail("readFileString", path))
        : Effect.succeed(new TextDecoder().decode(data));
    },
    writeFile: (path, data, options) =>
      write("writeFile", path, data, options?.flag?.startsWith("a") === true),
    writeFileString: (path, data, options) =>
      write(
        "writeFile",
        path,
        new TextEncoder().encode(data),
        options?.flag?.startsWith("a") === true,
      ),
    open: (path) =>
      Effect.sync(() => {
        files.set(path, new Uint8Array());
        return {
          [FileSystem.FileTypeId]: FileSystem.FileTypeId,
          writeAll: (buffer: Uint8Array) => write("writeAll", path, buffer, true),
          sync: Effect.void,
        } as unknown as FileSystem.File;
      }),
    rename: (from, to) =>
      Effect.suspend(() => {
        const data = files.get(from);
        if (data === undefined) return Effect.fail(fail("rename", from));
        files.delete(from);
        files.set(to, data);
        return Effect.void;
      }),
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path);
      }),
    readDirectory: (path) =>
      Effect.sync(() =>
        [...files.keys()].flatMap((k) =>
          k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")
            ? [k.slice(path.length + 1)]
            : [],
        ),
      ),
    stat: (path) => {
      const data = files.get(path);
      if (data === undefined) return Effect.fail(fail("stat", path));
      return Effect.succeed({
        type: "File",
        size: ByteSize.bytes(data.length),
        mtime: Option.none(),
      } as unknown as FileSystem.File.Info);
    },
  });
  return {
    files,
    layer: Layer.succeed(FileSystem.FileSystem, fs),
    get failWrites() {
      return flags.failWrites;
    },
    set failWrites(value: boolean) {
      flags.failWrites = value;
    },
    get tearNextWrite() {
      return flags.tearNextWrite;
    },
    set tearNextWrite(value: boolean) {
      flags.tearNextWrite = value;
    },
  };
};
