// Node.js exposes WebAssembly as a global value, but TypeScript's ES2022 lib
// only declares it as a namespace (types only). This augments it with the
// runtime-callable static functions available in Node 20+.
declare var WebAssembly: {
  compile(bytes: BufferSource): Promise<WebAssembly.Module>;
  compileStreaming(source: Response): Promise<WebAssembly.Module>;
  instantiate(
    bytes: BufferSource,
    importObject?: WebAssembly.Imports,
  ): Promise<WebAssembly.WebAssemblyInstantiatedSource>;
  instantiate(
    moduleObject: WebAssembly.Module,
    importObject?: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance>;
  validate(bytes: BufferSource): boolean;
};
