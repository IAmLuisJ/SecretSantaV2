export type Exclusion = { firstId: string; secondId: string };
export type Assignment = { giverId: string; recipientId: string };

function shuffle<T>(items: T[]) {
  for (let index = items.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

export function findDraw(
  roster: string[],
  exclusions: Exclusion[],
  previous: Assignment[],
): Assignment[] | null {
  if (roster.length < 2) return null;

  const blocked = new Map(roster.map((id) => [id, new Set([id])]));
  for (const { firstId, secondId } of exclusions) {
    blocked.get(firstId)?.add(secondId);
    blocked.get(secondId)?.add(firstId);
  }
  for (const { giverId, recipientId } of previous) blocked.get(giverId)?.add(recipientId);

  const eligible = new Map(roster.map((giver) => [
    giver,
    shuffle(roster.filter((recipient) => !blocked.get(giver)?.has(recipient))),
  ]));
  const assignedGivers = new Map<string, string>();
  const assignedRecipients = new Map<string, string>();

  for (const unassigned of shuffle([...roster])) {
    const queue = [unassigned];
    const parents = new Map<string, string>();
    let availableRecipient: string | undefined;

    // Find an augmenting path that can reassign earlier matches to free a recipient.
    for (let index = 0; index < queue.length && availableRecipient === undefined; index++) {
      const giver = queue[index];
      for (const recipient of eligible.get(giver) ?? []) {
        if (parents.has(recipient)) continue;
        parents.set(recipient, giver);
        const currentGiver = assignedGivers.get(recipient);
        if (currentGiver === undefined) {
          availableRecipient = recipient;
          break;
        }
        queue.push(currentGiver);
      }
    }

    if (availableRecipient === undefined) return null;
    while (availableRecipient !== undefined) {
      const giver = parents.get(availableRecipient)!;
      const previousRecipient = assignedRecipients.get(giver);
      assignedGivers.set(availableRecipient, giver);
      assignedRecipients.set(giver, availableRecipient);
      availableRecipient = previousRecipient;
    }
  }

  return [...assignedRecipients].map(([giverId, recipientId]) => ({ giverId, recipientId }));
}
