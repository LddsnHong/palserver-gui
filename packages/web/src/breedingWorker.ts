/// <reference lib="webworker" />

import type { SaveBreedingPal } from "@palserver/shared";
import { solveBreeding, type BreedingData, type BreedingSolution } from "./breedingSolver";

interface BreedingWorkerRequest {
  data: BreedingData;
  owned: SaveBreedingPal[];
  targetId: string;
  desiredPassives: string[];
  maxGenerations: number;
}

type BreedingWorkerResponse =
  | { type: "progress"; routes: BreedingSolution["routes"] }
  | { type: "complete"; solution: BreedingSolution }
  | { type: "error"; error: string };

self.onmessage = (event: MessageEvent<BreedingWorkerRequest>) => {
  try {
    const { data, owned, targetId, desiredPassives, maxGenerations } = event.data;
    const solution = solveBreeding(
      data,
      owned,
      targetId,
      desiredPassives,
      maxGenerations,
      (routes) => {
        const response: BreedingWorkerResponse = { type: "progress", routes };
        self.postMessage(response);
      },
    );
    const response: BreedingWorkerResponse = { type: "complete", solution };
    self.postMessage(response);
  } catch (error) {
    const response: BreedingWorkerResponse = {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
