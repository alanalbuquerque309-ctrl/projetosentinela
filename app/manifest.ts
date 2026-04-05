import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sentinela — contas a pagar",
    short_name: "Sentinela",
    description:
      "Organize boletos, faturas e extratos. Sem ligar ao banco — voce envia o arquivo.",
    start_url: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#065f46",
    orientation: "portrait",
    icons: [
      {
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
