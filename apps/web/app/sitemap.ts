import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.APP_URL ?? "https://ownrabbit.vercel.app").replace(/\/+$/, "");
  return [{ url: `${base}/`, changeFrequency: "weekly", priority: 1 }];
}
