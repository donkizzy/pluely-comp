import type { Profile, KnowledgeHit } from "../database/knowledge.action";

// Count UTF-8 bytes conservatively: even byte-fallback tokenizers cannot exceed this budget.
export function limitText(text: string, budget: number): string {
  const encoder = new TextEncoder();
  let result = "",
    used = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (used + size > budget) break;
    result += character;
    used += size;
  }
  return result;
}
export function profileContext(profile: Profile): string {
  if (!profile.includeInContext) return "";
  // Salary is deliberately absent. It is never sent by automatic context or drafting helpers.
  return limitText(
    [
      profile.name && `Name: ${profile.name}`,
      profile.currentRole && `Current role: ${profile.currentRole}`,
      profile.yearsExperience && `Experience: ${profile.yearsExperience} years`,
      profile.targetRoles && `Target: ${profile.targetRoles}`,
      `Tone: ${profile.tone}`,
      `Never say: ${profile.neverSay}`,
      profile.summary,
    ]
      .filter(Boolean)
      .join("\n"),
    300,
  );
}
export function sourceContext(hits: KnowledgeHit[], budget = 4500): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  let remaining = budget;
  for (const hit of hits) {
    const key = `${hit.document_id}:${hit.text}`;
    if (seen.has(key) || hit.kind === "story" || blocks.length === 5) continue;
    seen.add(key);
    const text = limitText(
      `[${hit.kind}: ${hit.title}]\n${hit.text}`,
      Math.min(1000, remaining),
    );
    if (!text) break;
    blocks.push(text);
    remaining -= new TextEncoder().encode(text).length;
  }
  return blocks.join("\n\n");
}
