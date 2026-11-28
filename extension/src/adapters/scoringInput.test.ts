// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFeatures, FEATURE_NAMES, type Link } from '../features';
import { bodyText, scanLinks, withSubject } from './extract';

/**
 * ml/tests/fixtures/scoring_input.json: raw email fields -> the (body, links) the extension scores -> features.
 * Training must compute features from the same input the browser scores (ml/src/phishml/data.py scoring_input),
 * so any change here to withSubject, bodyText or scanLinks (incl. redirect unwrapping) updates that fixture and
 * its Python mirror together.
 */
interface ScoringCase {
  name: string;
  sender: string;
  subject: string;
  body: string;
  links: Link[];
  expected_input: { body: string; links: Link[] };
  expected_features: Record<string, number>;
}

// A path, not a URL: under happy-dom the global URL is not Node's, and readFileSync rejects it.
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ml/tests/fixtures/scoring_input.json');
const CASES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ScoringCase[];

/** The message as the adapters see it: the body as one text node, the links as <a href> elements. */
function scored(c: ScoringCase): { body: string; links: Link[] } {
  const bodyEl = document.createElement('div');
  bodyEl.append(document.createTextNode(c.body));
  const linkEl = document.createElement('div');
  for (const l of c.links) {
    const a = document.createElement('a');
    a.setAttribute('href', l.href);
    a.textContent = l.text;
    linkEl.append(a);
  }
  return { body: withSubject(c.subject, bodyText(bodyEl)), links: scanLinks(linkEl).links };
}

describe('scoring_input.json contract (extension <-> ML pipeline)', () => {
  it('covers all FEATURE_NAMES', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(5);
    for (const c of CASES) expect(Object.keys(c.expected_features).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it.each(CASES)('builds the expected scoring input and features for $name', (c) => {
    const input = scored(c);
    expect(input).toEqual(c.expected_input);
    expect(extractFeatures(c.sender, input.body, input.links)).toEqual(c.expected_features);
  });
});
