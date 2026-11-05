import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Front Run",
    short_name: "Front Run",
    description: "Trade any token from one USDC balance on Arc, with theses from people who actually hold.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0c0b",
    theme_color: "#0a0c0b",
    categories: ["finance"],
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png" },
      { src: "/icons/512", sizes: "512x512", type: "image/png" },
      { src: "/icons/512?maskable=1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
