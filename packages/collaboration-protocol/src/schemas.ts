import type { AnySchemaObject } from "ajv";
import wireMessageSchemaJson from "./schemas/wire-message.schema.json" with { type: "json" };

type RootSchema = AnySchemaObject & { $defs: Record<string, AnySchemaObject> };

export const wireMessageSchema = wireMessageSchemaJson as unknown as RootSchema;
export const PROTOCOL_SCHEMA_ID = wireMessageSchema.$id as string;

function definitionSchema(...definitionNames: string[]): AnySchemaObject {
  const reference = (name: string) => ({ $ref: `#/$defs/${name}` });
  return {
    $schema: wireMessageSchema.$schema as string,
    $defs: wireMessageSchema.$defs,
    ...(definitionNames.length === 1
      ? reference(definitionNames[0]!)
      : { oneOf: definitionNames.map(reference) }),
  };
}

export const roomSnapshotSchema = definitionSchema("roomSnapshot");
export const presenceSchema = definitionSchema("presenceState", "presencePublishCommand", "presenceChangedEvent");
export const annotationSchema = definitionSchema("annotation", "annotationMutation", "annotationMutationAck", "annotationChangedEvent");
export const writerControlSchema = definitionSchema(
  "writerControlState",
  "writerControlCasCommand",
  "writerControlAck",
  "writerControlChangedEvent",
  "writerFenceAdvancedEvent",
);
export const recoveryDraftSchema = definitionSchema(
  "recoveryDraft",
  "recoveryDraftPutMutation",
  "recoveryDraftDeleteMutation",
  "recoveryDraftAck",
  "recoveryDraftChangedEvent",
);
export const terminalSchema = definitionSchema(
  "terminalControlCommand",
  "terminalInputCommand",
  "terminalControlAck",
  "terminalInputRejectedEvent",
);
export const commandEnvelopeSchema = definitionSchema("commandEnvelope");
export const eventEnvelopeSchema = definitionSchema("durableEventEnvelope", "ephemeralEventEnvelope");
export const snapshotEnvelopeSchema = definitionSchema("snapshotEnvelope");
export const negotiationSchema = definitionSchema(
  "protocolClientHello",
  "protocolServerAccept",
  "protocolServerReject",
);
