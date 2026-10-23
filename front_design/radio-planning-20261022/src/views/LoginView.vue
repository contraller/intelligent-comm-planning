<template>
  <main class="login-page">
    <header>
      <span class="login-logo"><i class="pi pi-wifi" /></span><strong>无线网络智能规划系统</strong
      ><span class="chip">教学演示平台</span>
    </header>
    <div class="login-main">
      <section class="login-story">
        <p class="eyebrow">RADIO NETWORK · INTELLIGENT PLANNING</p>
        <h1>连接全域资源<br /><span>洞察网络态势</span></h1>
        <p class="login-description">
          面向教学演示的无线网络规划与诊断工作台。<br />让资源、方案与知识，在同一张网络中清晰呈现。
        </p>
        <div
          class="network-art"
          aria-hidden="true"
        >
          <svg viewBox="0 0 640 300">
            <defs>
              <linearGradient
                id="line"
                x1="0"
                x2="1"
              >
                <stop
                  offset="0"
                  stop-color="#286799"
                />
                <stop
                  offset="1"
                  stop-color="#45b8c4"
                />
              </linearGradient>
            </defs>
            <g
              fill="none"
              stroke="url(#line)"
              stroke-width="1.2"
            >
              <path
                d="M80 160L220 75L340 145L475 50L570 165L450 245L340 145L200 250L80 160M220 75L200 250M340 145L570 165M220 75L475 50"
              />
              <path
                d="M80 160L450 245M200 250L570 165"
                stroke-dasharray="5 7"
                opacity=".4"
              />
            </g>
            <g
              fill="#153d5a"
              stroke="#459bc3"
              stroke-width="1.5"
            >
              <circle
                cx="80"
                cy="160"
                r="13"
              />
              <circle
                cx="220"
                cy="75"
                r="17"
              />
              <circle
                cx="340"
                cy="145"
                r="28"
              />
              <circle
                cx="475"
                cy="50"
                r="13"
              />
              <circle
                cx="570"
                cy="165"
                r="16"
              />
              <circle
                cx="450"
                cy="245"
                r="13"
              />
              <circle
                cx="200"
                cy="250"
                r="14"
              />
            </g>
            <g fill="#74d0e6">
              <circle
                cx="80"
                cy="160"
                r="4"
              />
              <circle
                cx="220"
                cy="75"
                r="5"
              />
              <circle
                cx="340"
                cy="145"
                r="8"
              />
              <circle
                cx="475"
                cy="50"
                r="4"
              />
              <circle
                cx="570"
                cy="165"
                r="5"
              />
              <circle
                cx="450"
                cy="245"
                r="4"
              />
              <circle
                cx="200"
                cy="250"
                r="4"
              />
            </g>
            <circle
              cx="340"
              cy="145"
              r="48"
              fill="none"
              stroke="#367d9a"
              opacity=".35"
            />
            <circle
              cx="340"
              cy="145"
              r="75"
              fill="none"
              stroke="#367d9a"
              opacity=".15"
            /></svg
          ><span class="art-label art-one">RESOURCE</span
          ><span class="art-label art-two">NETWORK</span
          ><span class="art-label art-three">KNOWLEDGE</span>
        </div>
        <div class="login-features">
          <span><i class="pi pi-globe" />GIS 态势</span
          ><span><i class="pi pi-share-alt" />智能规划</span
          ><span><i class="pi pi-wave-pulse" />故障诊断</span
          ><span><i class="pi pi-sitemap" />知识图谱</span>
        </div>
      </section>
      <section class="login-card">
        <div class="login-card-heading">
          <span class="chip blue">{{ isMock ? 'Mock 演示登录' : '账号登录' }}</span>
          <h2>进入规划工作台</h2>
          <p>{{ isMock ? '使用演示账号进入相应角色的工作区' : '使用账号进入相应角色的工作区' }}</p>
        </div>
        <form @submit.prevent="login">
          <label
            >账号
            <div class="login-input">
              <i class="pi pi-user" /><input
                v-model="username"
                required
                autocomplete="off"
                :aria-label="isMock ? '演示账号' : '账号'" /></div></label
          ><label
            >密码
            <div class="login-input">
              <i class="pi pi-lock" /><input
                :type="passwordVisible ? 'text' : 'password'"
                v-model="password"
                @input="passwordEdited = true"
                required
                autocomplete="off"
                :aria-label="isMock ? '演示密码' : '密码'" /><button
                type="button"
                class="icon-btn"
                :aria-label="passwordVisible ? '隐藏密码' : '显示密码'"
                @click="passwordVisible = !passwordVisible"
              >
                <i
                  class="pi"
                  :class="passwordVisible ? 'pi-eye-slash' : 'pi-eye'"
                /> </button></div></label
          ><button
            class="btn primary login-enter"
            :disabled="submitting || auth.transition || !!auth.busy || recovering"
            >登录工作区<i class="pi pi-arrow-right"
          /></button>
          <p
            v-if="message"
            role="alert"
            >{{ message }}</p
          >
          <button
            v-if="isMock && recoverable"
            type="button"
            class="btn"
            @click="recovery = true"
            >重新初始化系统配置</button
          >
          <button
            v-if="!isMock"
            type="button"
            class="btn"
            :disabled="submitting || auth.transition || !!auth.busy"
            @click="reloadSession"
            >重新读取登录状态</button
          >
        </form>
        <div class="login-note">
          <i class="pi pi-info-circle" />
          <p v-if="isMock"
            >公开演示口令：{{
              catalog?.passwordHint ?? '请等待账号目录加载'
            }}。会话保存在当前标签页，刷新后重新校验；业务结果来自 Mock 或预生成数据。</p
          >
          <p v-else>此浏览器的标签页共享登录，退出会影响其他标签页。刷新后重新校验身份和权限。</p>
        </div>
        <details v-if="isMock && catalog"
          ><summary>演示账号与角色</summary
          ><div
            v-for="a in catalog.accounts"
            :key="a.username"
            ><button
              type="button"
              class="text-link"
              @click="username = a.username"
              >{{ a.username }}</button
            >
            · {{ a.role }}{{ a.enabled ? '' : '（停用）' }}</div
          ></details
        >
      </section>
    </div>
    <Dialog
      v-if="isMock"
      :visible="recovery"
      header="重新初始化系统配置"
      modal
      @update:visible="recovery = $event"
      ><p
        >仅在配置损坏或版本不兼容时可重新初始化账号、角色及参数，不迁移旧配置；旧会话失效，业务数据与日志保留。请输入
        admin 和公开演示口令。</p
      ><label>账号<input v-model="username" /></label
      ><label
        >演示口令<input
          v-model="password"
          type="password"
          autocomplete="off" /></label
      ><p role="alert">{{ message }}</p
      ><template #footer
        ><button
          class="btn"
          :disabled="recovering"
          @click="recovery = false"
          >取消</button
        ><button
          class="btn primary"
          :disabled="recovering"
          @click="recover"
          >确认恢复</button
        ></template
      ></Dialog
    >
    <footer>
      <span>无线网络智能规划系统 · {{ isMock ? '前端演示环境' : 'HTTP 接口环境' }}</span
      ><span>{{ isMock ? '本地资源运行' : '同源会话登录' }} <b>·</b> v0.1</span>
    </footer>
  </main>
</template>
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import { env } from '../config/env';
import type { LoginCatalog } from '../types/system';
import Dialog from 'primevue/dialog';
const router = useRouter();
const isMock = env.mode === 'mock';
const passwordVisible = ref(false);
const auth = useAuthStore();
const route = useRoute();

// 仅在 Mock 演示中预选管理员，HTTP 模式保持空账号。
const username = ref(isMock ? 'admin' : '');
// 密码只在当前表单内使用，提交完成即清空，不进入任何持久化记录。
const password = ref('');
// 目录异步返回时，保留用户已经输入或主动清空的密码。
const passwordEdited = ref(false);
const catalog = ref<LoginCatalog | null>(null);
const message = ref('');
const recovery = ref(false);
const recoverable = ref(false);
const recovering = ref(false);
const submitting = ref(false);
// 正式模式不查询演示账号目录，也不暴露本地系统恢复入口。
onMounted(async () => {
  if (!isMock) {
    message.value = auth.error;
    return;
  }
  try {
    catalog.value = await previewService.getLoginCatalog();
    if (!passwordEdited.value && !password.value) password.value = catalog.value.passwordHint;
  } catch (e) {
    message.value = e instanceof Error ? e.message : '演示账号读取失败';
  }
});
async function login() {
  if (submitting.value) return;
  submitting.value = true;
  message.value = '';
  recoverable.value = false;
  try {
    if (await auth.login(username.value, password.value))
      await router.replace(auth.firstPath(route.query.next));
    else {
      message.value = auth.error;
      recoverable.value =
        isMock && ['SYSTEM_CORRUPT', 'SYSTEM_INCOMPATIBLE'].includes(auth.errorCode);
    }
  } catch (e) {
    message.value = e instanceof Error ? e.message : '登录失败';
  } finally {
    password.value = '';
    submitting.value = false;
  }
}
async function recover() {
  if (!isMock) return;
  recovering.value = true;
  try {
    await previewService.recoverSystemWorkspace({
      username: username.value,
      password: password.value,
    });
    recovery.value = false;
    recoverable.value = false;
    message.value = '系统配置已恢复，请重新输入演示口令登录。';
  } catch (e) {
    message.value = e instanceof Error ? e.message : '恢复失败';
  } finally {
    password.value = '';
    recovering.value = false;
  }
}
async function reloadSession() {
  if (isMock || submitting.value) return;
  submitting.value = true;
  password.value = '';
  try {
    if (await auth.discardRestricted()) {
      if (auth.identity && !auth.error) await router.replace(auth.firstPath(route.query.next));
      else message.value = auth.error || '当前未登录，请输入账号和密码。';
    }
  } finally {
    submitting.value = false;
  }
}
</script>
<style scoped>
.login-page {
  min-height: 100vh;
  background: radial-gradient(ellipse at 20% 50%, #122e49, #080f1e 65%);
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.login-page:before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(#42739008 1px, transparent 1px),
    linear-gradient(90deg, #42739008 1px, transparent 1px);
  background-size: 48px 48px;
}
.login-page > header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 35px 65px;
  z-index: 1;
}
.login-logo {
  height: 40px;
  width: 40px;
  background: #1c6297;
  border-radius: 9px;
  display: grid;
  place-items: center;
  color: #acdfff;
  font-size: 23px;
  border: 1px solid #4ca1db;
}
header strong {
  font-size: 18px;
  letter-spacing: 1px;
}
header .chip {
  margin-left: auto;
}
.login-main {
  flex: 1;
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  align-items: center;
  gap: 110px;
  padding: 45px 10% 75px;
  z-index: 1;
}
.login-story h1 {
  font-size: 46px;
  line-height: 1.5;
  margin: 26px 0 20px;
  letter-spacing: 3px;
}
.login-story h1 span {
  color: #76bde9;
}
.login-description {
  color: #819eba;
  line-height: 2.1;
  font-size: 14px;
}
.network-art {
  height: 275px;
  max-width: 650px;
  position: relative;
  margin-top: 16px;
}
.network-art svg {
  height: 100%;
  width: 100%;
}
.art-label {
  position: absolute;
  color: #4e8ca9;
  font-size: 8px;
  letter-spacing: 2px;
}
.art-one {
  left: 28%;
  top: 14%;
}
.art-two {
  left: 49%;
  top: 73%;
}
.art-three {
  left: 74%;
  top: 79%;
}
.login-features {
  display: flex;
  gap: 28px;
  padding-top: 20px;
  border-top: 1px solid #254259;
  max-width: 590px;
}
.login-features span {
  color: #729dbc;
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.login-card {
  max-width: 435px;
  width: 100%;
  padding: 38px;
  border: 1px solid #2c435d;
  border-radius: 12px;
  background: linear-gradient(140deg, #15263aeb, #0e192bfa);
  box-shadow: 0 25px 70px #02070f80;
}
.login-card h2 {
  font-size: 24px;
  margin: 23px 0 12px;
}
.login-card-heading > p {
  color: #7892ad;
  font-size: 12px;
  line-height: 1.8;
}
.login-card form {
  margin-top: 31px;
}
.login-card label {
  margin-bottom: 21px;
  font-size: 12px;
}
.login-input {
  display: flex;
  align-items: center;
  background: #0b1729;
  border: 1px solid #2b3e58;
  border-radius: 5px;
  padding-left: 14px;
  height: 45px;
  color: #547997;
}
.login-input > input {
  background: transparent;
  border: 0;
  flex: 1;
  font-size: 12px;
}
.login-input .icon-btn {
  margin-right: 6px;
}
.login-disabled,
.login-enter {
  width: 100%;
  min-height: 43px;
  margin-top: 6px;
}
.login-enter {
  margin-top: 12px;
  justify-content: space-between;
  padding: 12px 17px;
}
.login-note {
  display: flex;
  gap: 10px;
  margin-top: 25px;
  font-size: 10px;
  line-height: 1.9;
  color: #6383a0;
}
.login-note .pi {
  margin-top: 3px;
}
.login-page > footer {
  display: flex;
  justify-content: space-between;
  padding: 24px 65px;
  color: #425e7b;
  font-size: 10px;
  z-index: 1;
}
.login-page footer b {
  margin: 0 10px;
  font-weight: 400;
}
@media (max-width: 1300px) {
  .login-main {
    gap: 60px;
    padding: 35px 8%;
  }
  .login-story h1 {
    font-size: 38px;
  }
  .network-art {
    height: 230px;
  }
  .login-features {
    gap: 18px;
  }
  .login-card {
    padding: 30px;
  }
}
</style>
