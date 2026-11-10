/**
 * Runtime schemas for simulator responses (V3 CH-2). Adapters validate every
 * body before reading it, so a malformed payload becomes a contract error
 * instead of partial data, empty strings or a default value.
 * Objects are not strict: extra fields from an upstream are ignored, except
 * where noted with z.looseObject because callers pass the body through.
 */
import { z } from "zod";
import { PriorAuthDraftCreatedSchema } from "../domain/contracts";

const Ref = z.object({ reference: z.string().min(1) });
const NonEmpty = z.string().min(1);
const Bundle = <T extends z.ZodType>(resource: T) => z.object({ entry: z.array(z.object({ resource })).optional() });

export const EmitResultWire = z.object({ event: PriorAuthDraftCreatedSchema, deliveryCount: z.number().int().positive() });

/** Loose: the workspace API passes the draft body through unchanged. */
export const DraftWire = z.looseObject({
  id: NonEmpty,
  version: z.number().int().positive(),
  serviceRequestId: NonEmpty,
  patientId: NonEmpty,
  coverageId: NonEmpty,
  policyVersion: NonEmpty,
  businessStatus: z.enum(["DRAFT_INCOMPLETE", "EVIDENCE_REVIEW_PENDING"]),
  updatedAt: NonEmpty,
});

export const ServiceRequestWire = z.object({
  id: NonEmpty,
  subject: Ref,
  insurance: z.array(Ref).min(1),
  code: z.object({ text: NonEmpty }),
  category: z.array(z.object({ text: NonEmpty })).min(1),
  requester: Ref,
});

export const CoverageWire = z.object({
  id: NonEmpty,
  beneficiary: Ref,
  class: z.array(z.object({ value: NonEmpty, name: NonEmpty })).min(1),
});

export const PatientWire = z.object({
  id: NonEmpty,
  extension: z.array(z.object({ url: z.string(), valueString: z.string().optional() })),
});

export const LocalDocBundleWire = Bundle(z.object({ id: NonEmpty, type: z.object({ text: NonEmpty }), description: z.string(), date: NonEmpty }));

export const AccessAuthorizationWire = z.object({
  patientId: NonEmpty,
  providerOrgId: NonEmpty,
  attributed: z.boolean(),
  treatmentRelationship: z.string(),
  optedOut: z.boolean(),
  decision: z.enum(["PERMIT", "DENY"]),
  reasons: z.array(z.string()),
});

export const EobBundleWire = Bundle(
  z.object({
    id: NonEmpty,
    outcome: NonEmpty,
    provider: z.object({ reference: NonEmpty, display: z.string() }),
    item: z
      .array(
        z.object({
          servicedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          productOrService: z.object({ coding: z.array(z.object({ code: NonEmpty, display: z.string() })).min(1) }),
        }),
      )
      .min(1),
  }),
);

export const HieDocBundleWire = Bundle(
  z.object({
    id: NonEmpty,
    type: z.object({ text: NonEmpty }),
    subject: Ref,
    author: z.array(z.object({ reference: NonEmpty, display: z.string() })).min(1),
    description: z.string(),
    date: NonEmpty,
    context: z.object({ period: z.object({ start: NonEmpty, end: NonEmpty }) }),
    content: z.array(z.object({ attachment: z.object({ url: NonEmpty }) })).min(1),
    extension: z.array(z.object({ url: z.string(), valueCode: z.string().optional(), valueString: z.string().optional() })).default([]),
  }),
);

export const PolicyWire = z.object({
  policyVersion: NonEmpty,
  status: z.enum(["active", "retired"]),
  label: z.string().startsWith("SYNTHETIC"),
  effectiveFrom: NonEmpty,
  effectiveTo: z.string().nullable(),
  requirements: z
    .array(
      z.object({
        code: NonEmpty,
        description: z.string(),
        localDocumentTypes: z.array(z.string()),
        externalDocumentTypes: z.array(z.string()),
        lookbackMonths: z.number().int().positive(),
      }),
    )
    .min(1),
});

export const WriteCountWire = z.object({ since: z.string(), writeRequests: z.number().int().min(0) });

/** Body of a 409 from the EHR Task write. Only a matching shape counts as a version conflict. */
export const ConflictBodyWire = z.object({ code: z.enum(["VERSION_CONFLICT", "POLICY_CONFLICT", "INVALID_TRANSITION"]), currentVersion: z.number().int().positive().optional() });

/** Typed accessor: returns the conflict code, or null when the body is not a recognised conflict. */
export function conflictCodeOf(body: unknown): z.infer<typeof ConflictBodyWire>["code"] | null {
  const p = ConflictBodyWire.safeParse(body);
  return p.success ? p.data.code : null;
}
