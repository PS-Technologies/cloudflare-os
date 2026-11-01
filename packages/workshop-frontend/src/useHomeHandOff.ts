import { useEffect, useState } from "react";
import { claimHomeHandOff, homeHandOff } from "./homePrompt";

/** Keep render retries pure; a committed arrival owns the question even before models load. */
export const useHomeHandOff = (prompt: string | undefined): string | undefined => {
  const [handOff] = useState(() => homeHandOff(prompt));
  useEffect(() => {
    if (handOff) claimHomeHandOff();
  }, [handOff]);
  return handOff;
};
