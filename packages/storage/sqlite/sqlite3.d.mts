/** Official SQLite WASM module; narrow the result inside the Storage Worker. */
export default function sqlite3InitModule(options?: {
  locateFile?: (filename: string, prefix: string) => string;
  print?: (...args: unknown[]) => void;
  printErr?: (...args: unknown[]) => void;
}): Promise<unknown>;
