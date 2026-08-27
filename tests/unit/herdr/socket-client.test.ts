import { describe, expect, it } from "vitest";

import { localSocketEndpointFor } from "../../../src/herdr/socket-client.js";

describe("localSocketEndpointFor", () => {
  it("maps Herdr's Windows socket marker path to Node's named-pipe namespace", () => {
    expect(localSocketEndpointFor("C:\\Users\\ada\\AppData\\Roaming\\herdr\\herdr.sock", "win32")).toBe(
      "\\\\.\\pipe\\C:\\Users\\ada\\AppData\\Roaming\\herdr\\herdr.sock",
    );
  });

  it("preserves an already namespaced Windows pipe", () => {
    expect(localSocketEndpointFor("\\\\.\\pipe\\herdr-session", "win32")).toBe("\\\\.\\pipe\\herdr-session");
    expect(localSocketEndpointFor("\\\\?\\pipe\\herdr-session", "win32")).toBe("\\\\?\\pipe\\herdr-session");
  });

  it("leaves Unix-domain socket paths unchanged", () => {
    expect(localSocketEndpointFor("/tmp/herdr.sock", "linux")).toBe("/tmp/herdr.sock");
  });
});
