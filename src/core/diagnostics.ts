export function info(msg: string, ...args: any[]) {
  console.info(`[Rouse] ${msg}`, ...args);
}

export function warn(msg: string, ...args: any[]) {
  console.warn(`[Rouse] ${msg}`, ...args);
}

export function err(msg: string, ...args: any[]) {
  console.error(`[Rouse] ${msg}`, ...args);
}

export function fail(
  msg: string,
  ErrorClass: typeof Error | typeof TypeError = Error,
  options?: ErrorOptions,
): never {
  throw new ErrorClass(`[Rouse] ${msg}`, options);
}
