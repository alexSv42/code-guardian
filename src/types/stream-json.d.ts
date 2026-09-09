declare module "stream-chain" {
  import { Duplex } from "stream";
  function chain(streams: Array<unknown>): Duplex;
  export { chain };
}

declare module "stream-json" {
  import { Transform } from "stream";
  function parser(): Transform;
  export { parser };
}

declare module "stream-json/filters/Pick" {
  import { Transform } from "stream";
  function pick(options: { filter: RegExp | string }): Transform;
  export { pick };
}

declare module "stream-json/streamers/StreamValues" {
  import { Transform } from "stream";
  function streamValues(): Transform;
  export { streamValues };
}

declare module "stream-json/streamers/StreamArray" {
  import { Transform } from "stream";
  function streamArray(): Transform;
  export { streamArray };
}
