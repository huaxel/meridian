import type { SuggestedLink } from "../../../packages/shared/src";
import { number } from "./api";

export function matchText(
  link: Pick<
    SuggestedLink,
    "totalRows" | "matchedRows" | "caseInsensitive" | "matchBasis"
  >,
): string {
  if (link.matchBasis === "asserted")
    return "Catalog assertion · coverage not measured";
  if (link.matchBasis !== "measured") return "Coverage unverified";
  return `Measured: ${number(link.matchedRows)} of ${number(link.totalRows)} matched${link.caseInsensitive ? " · matched ignoring case" : ""}`;
}
