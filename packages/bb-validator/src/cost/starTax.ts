import type { TournamentPackage } from "../package/types";

type StarTaxBracket = NonNullable<TournamentPackage["starPlayers"]["spTaxByCombinedCost"]>[number];

export function starTaxSP(
  brackets: StarTaxBracket[] | undefined,
  combinedStarGold: number,
  starCount: number,
): number {
  if (!brackets || starCount === 0) return 0;
  return brackets.find((bracket) => bracket.upToGold === null || bracket.upToGold >= combinedStarGold)?.sp ?? 0;
}
