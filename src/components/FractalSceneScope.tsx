import type { ComponentProps } from "react";
import { FractalFlightScope } from "./FractalFlightScope";
/** The backdrop uses the original Newton renderer in every phase view. */
export function FractalSceneScope(
  props: ComponentProps<typeof FractalFlightScope>,
) {
  return <FractalFlightScope {...props} />;
}
