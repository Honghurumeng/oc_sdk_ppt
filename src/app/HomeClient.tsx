"use client";

import * as React from "react";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import CloseRounded from "@mui/icons-material/CloseRounded";
import SettingsRounded from "@mui/icons-material/SettingsRounded";

import PptJobForm from "@/components/PptJobForm";
import LlmConfigForm from "@/components/LlmConfigForm";

export default function HomeClient() {
  const [llmOpen, setLlmOpen] = React.useState(false);

  return (
    <Box sx={{ minHeight: "100vh" }}>
      <AppBar
        position="sticky"
        elevation={0}
        sx={{
          bgcolor: "rgba(251, 247, 239, 0.72)",
          color: "text.primary",
          borderBottom: "1px solid",
          borderColor: "divider",
          backdropFilter: "blur(10px)",
        }}
      >
        <Toolbar>
          <Container maxWidth="md" disableGutters sx={{ px: { xs: 2, sm: 2 } }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Box>
                <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: -0.5 }}>
                  OpenCode PPT Studio
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ display: { xs: "none", sm: "block" }, color: "text.secondary" }}
                >
                  前端输入主题，后端用 @opencode-ai/sdk 驱动 LLM 生成 PPTX + 预览图
                </Typography>
              </Box>

              <Stack direction="row" alignItems="center" spacing={1}>
                <Button
                  variant="outlined"
                  startIcon={<SettingsRounded />}
                  onClick={() => setLlmOpen(true)}
                  sx={{ borderColor: "divider" }}
                >
                  LLM 配置
                </Button>
              </Stack>
            </Stack>
          </Container>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 } }}>
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
            <PptJobForm />
          </Paper>

          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            输出会写到 <code>web/workspace/jobs/&lt;jobId&gt;</code>
          </Typography>
        </Stack>
      </Container>

      <Dialog
        open={llmOpen}
        onClose={() => setLlmOpen(false)}
        fullWidth
        maxWidth="md"
        scroll="paper"
      >
        <DialogTitle
          sx={{
            pr: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 2,
          }}
        >
          <Box>
            <Typography sx={{ fontWeight: 800, letterSpacing: -0.2 }}>LLM 配置</Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              写入 <code>web/opencode.json</code>，并重载内嵌 opencode server
            </Typography>
          </Box>
          <IconButton aria-label="close" onClick={() => setLlmOpen(false)}>
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <LlmConfigForm embedded />
        </DialogContent>
      </Dialog>
    </Box>
  );
}
