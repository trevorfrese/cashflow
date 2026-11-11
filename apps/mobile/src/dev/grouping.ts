import { DEV_PERSONA_GROUP_LABELS, type DevPersona, type DevPersonaGroup } from '@cashflow/shared';

export interface PersonaSection {
  title: string;
  personas: DevPersona[];
}

export interface PersonaGroup {
  group: DevPersonaGroup;
  title: string;
  sections: PersonaSection[];
}

const ORDER: DevPersonaGroup[] = ['CUSTOMER', 'FRESH'];

/**
 * The persona list as the menu shows it: existing customers first, then fresh applicants,
 * each split into the sections the registry names, in the registry's order. A group with
 * no personas is left out.
 */
export function groupPersonas(personas: readonly DevPersona[]): PersonaGroup[] {
  return ORDER.flatMap((group) => {
    const sections: PersonaSection[] = [];
    for (const persona of personas) {
      if (persona.group !== group) continue;
      const section = sections.find((s) => s.title === persona.section);
      if (section) section.personas.push(persona);
      else sections.push({ title: persona.section, personas: [persona] });
    }
    return sections.length > 0 ? [{ group, title: DEV_PERSONA_GROUP_LABELS[group], sections }] : [];
  });
}
