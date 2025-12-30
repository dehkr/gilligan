export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export interface GilliEvent<T = HTMLElement> extends Event {
  readonly el: T;
  readonly detail?: any;
}
