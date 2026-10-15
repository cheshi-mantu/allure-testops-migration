/** Shapes of the ALM REST API (JSON), as far as the migration reads them. */

/** An entity as ALM sends it: a type and a list of fields, each with a list of values. */
export interface AlmEntityJson {
  Type?: string;
  type?: string;
  Fields?: AlmFieldJson[];
  fields?: AlmFieldJson[];
}

export interface AlmFieldJson {
  Name?: string;
  name?: string;
  values?: ({ value?: string | null; Value?: string | null } | null)[];
  Values?: ({ value?: string | null; Value?: string | null } | null)[];
}

export interface AlmCollectionJson {
  entities?: AlmEntityJson[];
  Entities?: AlmEntityJson[];
  TotalResults?: number;
  totalResults?: number;
}

/** An entity with its fields by name; empty values are left out. */
export interface AlmRecord {
  type: string;
  fields: Record<string, string[]>;
}

/** A field of the test entity, from the customization of the project. */
export interface AlmFieldDefinition {
  name: string;
  label: string;
  /** e.g. String, Memo, Number, Date, LookupList, UsersList, Reference. */
  type: string;
  system: boolean;
  active: boolean;
  multiValue: boolean;
}

export interface AlmUser {
  name: string;
  fullName: string | null;
  email: string | null;
}

export interface AlmDomain {
  name: string;
  projects: string[];
}

/** A test with everything the migration reads for it. */
export interface AlmTest {
  test: AlmRecord;
  /** Design steps in the order of the test. */
  steps: AlmRecord[];
  parameters: AlmRecord[];
  attachments: AlmRecord[];
  /** Attachments of design steps, by step id. */
  stepAttachments: Map<string, AlmRecord[]>;
}

export function one(record: AlmRecord | undefined, name: string): string | null {
  const value = record?.fields[name]?.[0];
  return value === undefined || value === "" ? null : value;
}

export function idOf(record: AlmRecord): number {
  return Number(one(record, "id"));
}
