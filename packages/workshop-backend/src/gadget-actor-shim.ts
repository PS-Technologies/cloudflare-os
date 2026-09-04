// Shim loaded as the gadget worker's main module so each forwarded facet call can carry a
// per-call bag of viewer-scoped binding stubs. The author's Gadget class is unchanged: `this.env.X`
// resolves from the bag while the call runs, and from the load-time env otherwise.
//
// `nodejs_als` must be on the worker's compatibilityFlags; without it this module fails to start.

export const GADGET_ACTOR_SHIM_MODULE = "__workshop_actor_shim.js";

export const GADGET_ACTOR_SHIM = `\
import { AsyncLocalStorage } from "node:async_hooks";
import * as author from "./server.js";
export * from "./server.js";
const actorContext = new AsyncLocalStorage();
export class Gadget extends author.Gadget {
  constructor(ctx, env) {
    super(ctx, new Proxy(env, {
      get(target, key, receiver) {
        const bag = actorContext.getStore();
        if (bag !== undefined && typeof key === "string" && key in bag) return bag[key];
        return Reflect.get(target, key, receiver);
      },
    }));
  }
  __invoke(bag, method, args) {
    return actorContext.run(bag, () => this[method](...args));
  }
}
`;
