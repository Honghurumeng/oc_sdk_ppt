"use client";

import * as React from "react";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import CssBaseline from "@mui/material/CssBaseline";
import GlobalStyles from "@mui/material/GlobalStyles";
import { ThemeProvider, createTheme } from "@mui/material/styles";

const monoFontFamily =
  "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#11110f" },
    secondary: { main: "#2a7f72" },
    background: {
      default: "#fbf7ef",
      paper: "rgba(255, 255, 255, 0.78)",
    },
    text: {
      primary: "#11110f",
      secondary: "rgba(17, 17, 15, 0.62)",
    },
    divider: "rgba(17, 17, 15, 0.14)",
  },
  shape: { borderRadius: 14 },
  typography: {
    fontFamily:
      "var(--font-geist-sans), ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif",
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backdropFilter: "blur(10px)",
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          textTransform: "none",
          borderRadius: 14,
        },
      },
    },
  },
});

export default function ThemeRegistry({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppRouterCacheProvider options={{ key: "mui" }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <GlobalStyles
          styles={{
            body: {
              background:
                "radial-gradient(900px 500px at 20% 20%, rgba(230, 167, 86, 0.22), transparent 65%), radial-gradient(700px 420px at 75% 30%, rgba(68, 150, 135, 0.18), transparent 70%), linear-gradient(180deg, #fbf7ef, #f2efe9)",
              minHeight: "100vh",
            },
            code: {
              fontFamily: monoFontFamily,
            },
          }}
        />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
