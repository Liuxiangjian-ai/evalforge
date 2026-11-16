import { PROMPT_VERSION, SYSTEM_PROMPT, mcqInstruction } from '../shared/constants.js';
import { makeRng, shuffle } from '../shared/rng.js';
import { sha256Hex } from '../shared/text.js';

/**
 * Render one benchmark item as a chat prompt.
 *
 * `shuffle` presents the same options in a different order for stability
 * testing. The returned `option_map` translates a displayed label back to the
 * canonical label so scoring never depends on presentation order.
 */
export function buildMcqPrompt(item, { shuffle: shouldShuffle = false, seed = '' } = {}) {
  const displayLabels = Object.keys(item.options || {});
  const order = shouldShuffle ? shuffle(displayLabels, makeRng('order', item.id, seed)) : displayLabels;
  const optionMap = {};
  order.forEach((originalLabel, index) => {
    optionMap[displayLabels[index]] = originalLabel;
  });

  const optionLines = order.map((originalLabel, index) => `${displayLabels[index]}. ${item.options[originalLabel]}`).join('\n');
  const user = [
    item.query,
    '',
    'Options:',
    optionLines,
    '',
    mcqInstruction(),
    '',
    `[${PROMPT_VERSION}]`,
  ].join('\n');

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    option_map: optionMap,
    display_order: order,
    prompt_sha256: sha256Hex(user),
  };
}

/** Canonical option order for a run without shuffling. */
export function identityMap(item) {
  return Object.fromEntries(Object.keys(item.options || {}).map((label) => [label, label]));
}
