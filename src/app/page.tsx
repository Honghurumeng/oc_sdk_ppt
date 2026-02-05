import styles from "./page.module.css";
import PptJobForm from "@/components/PptJobForm";
import LlmConfigForm from "@/components/LlmConfigForm";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.header}>
          <div className={styles.brand}>OpenCode PPT Studio</div>
          <div className={styles.sub}>
            Web 前端输入主题，后端用 @opencode-ai/sdk 驱动 LLM 生成 PPTX + 预览图。
          </div>
        </header>

        <section className={styles.card}>
          <PptJobForm />
        </section>

        <section className={styles.card} style={{ marginTop: 14 }}>
          <LlmConfigForm />
        </section>

        <footer className={styles.footer}>
          <span>
            输出会写到 <code>web/workspace/jobs/&lt;jobId&gt;</code>
          </span>
        </footer>
      </main>
    </div>
  );
}
