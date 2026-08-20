import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

import type { AgentDescriptor } from "../core/model.js";
import { EXECUTION_OPTIONS_URI } from "./execution-options.js";

export const PROTOCOL_VERSION = "1.0";

/**
 * Every discovered agent gets its own virtual Agent Card and endpoint
 * (spec §4). This is what makes delegation standard A2A: the caller selects an
 * endpoint described by a card, rather than smuggling a non-standard `target`
 * field into a SendMessage request.
 */
export function agentEndpointPath(name: string): string {
  return `/a2a/agents/${encodeURIComponent(name)}`;
}

export function cardForDescriptor(descriptor: AgentDescriptor, baseUrl: string): AgentCard {
  const url = `${baseUrl.replace(/\/$/, "")}${agentEndpointPath(descriptor.name)}`;

  return {
    name: descriptor.name,
    description: descriptor.description,
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: PROTOCOL_VERSION },
      { url, protocolBinding: "HTTP+JSON", tenant: "", protocolVersion: PROTOCOL_VERSION },
    ],
    provider: { organization: "herdr-a2a", url: baseUrl },
    // The runtime's own version, when Herdr reported one. Never invent it:
    // spec §46 forbids claiming anything Herdr did not verify.
    version: descriptor.runtime.manifestVersion ?? "unknown",
    capabilities: {
      // Streaming is served by the SDK's own subscription plumbing; the
      // underlying delivery is event-driven, not polled.
      streaming: true,
      pushNotifications: false,
      extensions: [
        {
          uri: EXECUTION_OPTIONS_URI,
          description: "Optional model selection and visible/headless placement for this delegation.",
          required: false,
          params: undefined,
        },
      ],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: skillsFor(descriptor),
    signatures: [],
  };
}

function skillsFor(descriptor: AgentDescriptor): AgentSkill[] {
  const skill: AgentSkill = {
    id: descriptor.descriptorKind === "custom" ? "profile" : "general-coding",
    name:
      descriptor.descriptorKind === "custom"
        ? `${descriptor.name} profile`
        : "General coding tasks",
    description:
      descriptor.profile?.instructions?.trim() ??
      `Delegate coding work to the ${descriptor.runtimeKind} agent running under Herdr.`,
    tags: buildTags(descriptor),
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
  return [skill];
}

/**
 * Tags carry the catalog's four separate discovery facts (spec §5.1) so a
 * client can see *why* an agent is or is not available without a second call.
 */
function buildTags(descriptor: AgentDescriptor): string[] {
  const r = descriptor.runtime;
  return [
    descriptor.descriptorKind,
    `runtime:${descriptor.runtimeKind}`,
    `launchable:${r.launchable}`,
    `running:${r.runningInstances}`,
    ...(r.hasDetectionManifest ? ["detection-manifest"] : []),
    ...(r.hasIntegration ? ["integration"] : []),
    ...(descriptor.available ? [] : ["unavailable"]),
  ];
}

/**
 * The gateway's own card, served at the well-known path. It advertises the
 * gateway as a discovery surface rather than as a coding agent, because A2A has
 * no standard "list every agent on this machine" call (spec §3) — the catalog
 * endpoint fills that gap locally.
 */
export function gatewayCard(baseUrl: string, agentCount: number): AgentCard {
  const root = baseUrl.replace(/\/$/, "");
  return {
    name: "herdr-a2a",
    description: `Delegation gateway for coding agents running under Herdr. Currently exposing ${agentCount} agent card(s) at ${root}/a2a/agents/<name>.`,
    supportedInterfaces: [
      { url: `${root}/a2a`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: PROTOCOL_VERSION },
    ],
    provider: { organization: "herdr-a2a", url: root },
    version: "0.1.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "discover",
        name: "Discover local agents",
        description: `List the agents this Herdr session can delegate to. GET ${root}/agents`,
        tags: ["discovery", "catalog"],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
    documentationUrl: `${root}/agents`,
  };
}
