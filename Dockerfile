# نستخدم إيميدج مايكروسوفت الرسمي اللي فيه متصفح Chromium مثبت جاهز
# ده بيوفر وقت البناء وبيضمن إن Playwright يشتغل صح على Render/Railway
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package*.json ./
# --ignore-scripts عشان نتجنب تحميل المتصفح تاني، هو أصلاً موجود في الإيميدج
RUN npm install --omit=dev --ignore-scripts

COPY . .

# Render و Railway بيحطوا متغير PORT تلقائيًا وقت التشغيل
EXPOSE 3000

CMD ["node", "server.js"]
