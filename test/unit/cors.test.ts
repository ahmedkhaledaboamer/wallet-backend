import { describe, expect, it } from "vitest";
import { parseCorsOrigins } from "../../src/app.module";

describe("parseCorsOrigins", () => {
  it("keeps clean origins", () => {
    expect(parseCorsOrigins("https://a.vercel.app")).toEqual(["https://a.vercel.app"]);
  });

  it("strips quotes, spaces and trailing slashes a dashboard may add", () => {
    expect(parseCorsOrigins(` "https://wallet-frontend-lyart.vercel.app/" `)).toEqual(["https://wallet-frontend-lyart.vercel.app"]);
    expect(parseCorsOrigins("'http://localhost:3000//'")).toEqual(["http://localhost:3000"]);
  });

  it("supports several comma-separated origins and drops empty entries", () => {
    expect(parseCorsOrigins("https://a.vercel.app/, http://localhost:3000 ,")).toEqual(["https://a.vercel.app", "http://localhost:3000"]);
  });
});
