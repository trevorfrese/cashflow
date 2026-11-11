import type { DevPersona } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { groupPersonas } from './grouping';

const persona = (key: string, group: DevPersona['group'], section: string): DevPersona => ({
  key,
  title: key,
  group,
  section,
  demonstrates: '',
  screens: [],
  email: `${key}@cashflow.local`,
  resettable: true,
  walkthrough: null,
  state: { exists: true, label: '', tone: 'neutral', businessName: null },
  nextEvent: null,
});

describe('groupPersonas', () => {
  it('puts existing customers before fresh applicants, whatever order they arrive in', () => {
    const groups = groupPersonas([
      persona('fresh-approved', 'FRESH', 'By intended outcome'),
      persona('active-plan', 'CUSTOMER', 'Plans'),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['CUSTOMER', 'FRESH']);
    expect(groups.map((g) => g.title)).toEqual(['Existing customers', 'Fresh applicants']);
  });

  it('splits a group into its sections and keeps the registry order inside each', () => {
    const groups = groupPersonas([
      persona('active-plan', 'CUSTOMER', 'Plans'),
      persona('declined', 'CUSTOMER', 'Decisions'),
      persona('delinquent', 'CUSTOMER', 'Plans'),
      persona('needs-info', 'CUSTOMER', 'Decisions'),
      persona('fresh-approved', 'FRESH', 'By intended outcome'),
      persona('fresh-declined', 'FRESH', 'By intended outcome'),
    ]);
    expect(groups[0]!.sections.map((s) => s.title)).toEqual(['Plans', 'Decisions']);
    expect(groups[0]!.sections[0]!.personas.map((p) => p.key)).toEqual([
      'active-plan',
      'delinquent',
    ]);
    expect(groups[0]!.sections[1]!.personas.map((p) => p.key)).toEqual(['declined', 'needs-info']);
    expect(groups[1]!.sections[0]!.personas.map((p) => p.key)).toEqual([
      'fresh-approved',
      'fresh-declined',
    ]);
  });

  it('leaves out a group with nobody in it', () => {
    expect(groupPersonas([])).toEqual([]);
    expect(groupPersonas([persona('declined', 'CUSTOMER', 'Decisions')]).length).toBe(1);
  });
});
