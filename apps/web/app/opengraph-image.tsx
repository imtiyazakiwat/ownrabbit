import { ImageResponse } from "next/og";

export const alt = "OwnRabbit: open-source AI code review";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#0f0e0c",
          color: "#f1ead9",
          fontFamily: "Georgia, serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, fontSize: 40 }}>
          <span style={{ fontFamily: "monospace", color: "#8fd694" }}>+</span>
          <span style={{ fontFamily: "monospace", color: "#ff8a7a", marginLeft: -12 }}>-</span>
          <span style={{ display: "flex" }}>
            <span>Own</span>
            <span style={{ color: "#ff7a1a", fontStyle: "italic" }}>Rabbit</span>
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 88, lineHeight: 1.02, letterSpacing: -2 }}>Reviews that read</div>
          <div style={{ display: "flex", fontSize: 88, lineHeight: 1.02, letterSpacing: -2 }}>
            <span style={{ color: "#ff7a1a", fontStyle: "italic" }}>the whole</span>
            <span>&nbsp;story.</span>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 24, color: "#a39a88" }}>
          <span>Open-source AI pull request reviewer</span>
          <span>triage · specialists · judge</span>
        </div>
      </div>
    ),
    size,
  );
}
