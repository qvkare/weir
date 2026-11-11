// The /simulate Web Worker: the real engine and the agents' simulation, off the main thread.
import { createSimulation, type Simulation } from "@weir/agents/sim";
import { snapshot, toLines, type SimConfigInput } from "./sim-snapshot.ts";

export type SimRequest =
  | { type: "init"; config: SimConfigInput }
  | { type: "step"; seconds: number }
  | { type: "skip" }
  | { type: "rounds"; n: number }
  | { type: "settle" };

let sim: Simulation | null = null;

const reply = (msg: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const req = e.data;
  try {
    if (req.type === "init") {
      sim = createSimulation({ seed: req.config.seed, buyers: 3, sellers: 3, makers: 2, noise: 2, market: req.config.market });
      reply({ type: "state", reset: true, events: toLines([...sim.log]).slice(-300), snapshot: snapshot(sim) });
      return;
    }
    if (!sim) throw new Error("the simulation has not started");
    const events = req.type === "step" ? sim.step(req.seconds) : req.type === "skip" ? sim.skipToClearing() : req.type === "rounds" ? sim.runRounds(req.n) : sim.settleAll();
    reply({ type: "state", reset: false, events: toLines(events).slice(-300), snapshot: snapshot(sim) });
  } catch (err) {
    reply({ type: "error", message: (err as Error).message });
  }
};
