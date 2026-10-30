import { decodeBinarySchema, encodeBinarySchema } from "@figref/kiwi";
import type { FigFile, RawMagic } from "@figref/fig-format";

// Local file library in IndexedDB.
//   files   metadata + thumbnail (cheap to list)
//   bytes   the .fig bytes, keyed by file id (loaded only when opening)
//   meta    "schema": the most recent .fig schema seen, used to create new files

export interface LibraryFile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  size: number;
  thumbnail?: Blob;
  origin: "new" | "import" | "sample";
}

interface StoredSchema {
  magic: RawMagic;
  version: number;
  schema: Uint8Array;
}

const DB_NAME = "figref";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" });
      if (!d.objectStoreNames.contains("bytes")) d.createObjectStore("bytes");
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(stores, mode);
        const req = fn(tx);
        tx.oncomplete = () => resolve(req ? req.result : (undefined as T));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
      }),
  );
}

export function listFiles(): Promise<LibraryFile[]> {
  return run<LibraryFile[]>(["files"], "readonly", (tx) => tx.objectStore("files").getAll()).then((files) =>
    files.sort((a, b) => b.updatedAt - a.updatedAt),
  );
}

export function getFile(id: string): Promise<LibraryFile | undefined> {
  return run(["files"], "readonly", (tx) => tx.objectStore("files").get(id));
}

export function getBytes(id: string): Promise<Uint8Array | undefined> {
  return run(["bytes"], "readonly", (tx) => tx.objectStore("bytes").get(id));
}

export async function saveFile(file: LibraryFile, bytes?: Uint8Array): Promise<void> {
  await run(["files", "bytes"], "readwrite", (tx) => {
    tx.objectStore("files").put(file);
    if (bytes) tx.objectStore("bytes").put(bytes, file.id);
  });
}

export async function renameFile(id: string, name: string): Promise<void> {
  const f = await getFile(id);
  if (f) await saveFile({ ...f, name, updatedAt: Date.now() });
}

export async function deleteFile(id: string): Promise<void> {
  await run(["files", "bytes"], "readwrite", (tx) => {
    tx.objectStore("files").delete(id);
    tx.objectStore("bytes").delete(id);
  });
}

export function newFileId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Remembers the schema of an opened file (newest version wins) so new files can be created later. */
export async function rememberSchema(fig: FigFile): Promise<void> {
  const current = await run<StoredSchema | undefined>(["meta"], "readonly", (tx) => tx.objectStore("meta").get("schema"));
  if (current && current.version > fig.version) return;
  const stored: StoredSchema = { magic: fig.magic, version: fig.version, schema: encodeBinarySchema(fig.schema) };
  await run(["meta"], "readwrite", (tx) => {
    tx.objectStore("meta").put(stored, "schema");
  });
}

/** A minimal FigFile carrying only what documentToFig needs from a base: header + schema. */
export async function baseFig(): Promise<FigFile | null> {
  const s = await run<StoredSchema | undefined>(["meta"], "readonly", (tx) => tx.objectStore("meta").get("schema"));
  if (!s) return null;
  return {
    magic: s.magic,
    version: s.version,
    schema: decodeBinarySchema(s.schema),
    message: {},
    compression: ["deflate-raw", "deflate-raw"],
    extraChunks: [],
  };
}
