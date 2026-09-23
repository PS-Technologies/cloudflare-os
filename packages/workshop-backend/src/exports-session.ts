// A gadget binding's `exports`: the RpcTarget behind the `GadgetExports` interface
// (exports-binding.d.ts defines the agent-facing contract), present in the agent's executeCode env.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GadgetExportFormat, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { GadgetExports } from "./exports-binding";

/** What the binding needs from the overseer: the export pipeline behind GadgetClient's. */
export interface ExportsHost {
  getGadgetExportFormats(gadgetId: WorkpieceId, chatId?: number, actorProfileId?: string)
      : Promise<GadgetExportFormat[]>;
  exportGadget(gadgetId: WorkpieceId, formatId: string, chatId?: number, actorProfileId?: string)
      : Promise<ReadableStream<Uint8Array>>;
}

/** A gadget binding's `exports`. */
@validateRpc()
export class GadgetExportsImpl extends RpcTarget implements GadgetExports {
  #host: ExportsHost;
  #gadgetId: WorkpieceId;
  #chatId: number;
  #actorProfileId: string | undefined;

  // `actorProfileId` is the person whose turn the agent is taking, so an export runs as them.
  constructor(host: ExportsHost, gadgetId: WorkpieceId, chatId: number, actorProfileId?: string) {
    super();
    this.#host = host;
    this.#gadgetId = gadgetId;
    this.#chatId = chatId;
    this.#actorProfileId = actorProfileId;
  }

  async getFormats(): Promise<GadgetExportFormat[]> {
    return this.#host.getGadgetExportFormats(this.#gadgetId, this.#chatId, this.#actorProfileId);
  }

  async export(formatId: string): Promise<ReadableStream<Uint8Array>> {
    return this.#host.exportGadget(
        this.#gadgetId, formatId, this.#chatId, this.#actorProfileId);
  }
}
