/*
 * The folder where takes are saved, remembered between visits.  The browser can keep the folder's
 * handle in IndexedDB.  In each new session it asks for permission again, and that has to happen
 * during a click.
 */

/** Permission methods that Chrome has but TypeScript's DOM types don't include yet. */
type WithPermission = FileSystemDirectoryHandle & {
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
};

const DATABASE = "record-mode";
const STORE = "folders";
const KEY = "takes";

function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = run(open.result.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

/** The folder chosen last time, if there is one. */
export async function rememberedFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await inStore("readonly", (store) => store.get(KEY));
  } catch {
    return undefined;
  }
}

/** Save takes here from now on. */
export async function rememberFolder(folder: FileSystemDirectoryHandle) {
  await inStore("readwrite", (store) => store.put(folder, KEY));
}

/** Ask the user for a folder.  Undefined if they cancel.  Call this from a click. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (options: object) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) {
    throw new Error("This browser can't save into a folder.  Try Chrome.");
  }
  try {
    const folder = await picker({ id: "record-mode", mode: "readwrite" });
    await rememberFolder(folder);
    return folder;
  } catch (error) {
    if (error instanceof DOMException && error.name == "AbortError") {
      return undefined;
    }
    throw error;
  }
}

/** Can we write to this folder?  If ask is true, ask for permission if we need it.  That needs a click. */
export async function canWrite(folder: FileSystemDirectoryHandle, ask: boolean) {
  const handle = folder as WithPermission;
  // Folders that don't need permission, like the browser's private storage, don't have these.
  if (!handle.queryPermission || !handle.requestPermission) {
    return true;
  }
  if ((await handle.queryPermission({ mode: "readwrite" })) == "granted") {
    return true;
  }
  return ask && (await handle.requestPermission({ mode: "readwrite" })) == "granted";
}
