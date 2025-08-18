const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs').promises;
const { PassThrough } = require('stream');

const app = express();
const port = process.env.PORT || 3000;

// --- 파일 경로 설정 ---
const OAUTH_CRED_PATH = path.join(__dirname, 'oauth_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const DB_PATH = path.join(__dirname, 'db.json');
const STUDENTS_DB_PATH = path.join(__dirname, 'students.json');

// --- 드라이브 폴더 ID 설정 ---
const GOOGLE_DRIVE_FOLDER_IDS = {
    '1': '1fuD3yjwBWK1G6KRcXoITumaxl5cvI60j',
    '2': '1lghipVknF8WAd8yNVFX-t4qVEQGqEfOi',
    '3': '1O-Et4QxEDH0IgT6zO-xyfIwvRKuE_jrs',
    '4': '1Wi1fCZcVUbBVv_IBYzNDBB2bBDqwvg68',
};

let oAuth2Client;
let isGoogleReady = false; // 구글 인증 완료 여부 플래그

// --- Helper 함수 (DB 읽기/쓰기) ---
const readStudentsDb = async () => JSON.parse(await fs.readFile(STUDENTS_DB_PATH, 'utf-8'));
const writeStudentsDb = async (data) => await fs.writeFile(STUDENTS_DB_PATH, JSON.stringify(data, null, 2));
const readDb = async () => { try { await fs.access(DB_PATH); const dbData = await fs.readFile(DB_PATH, 'utf-8'); return JSON.parse(dbData); } catch (error) { return { uploads: [] }; } };
const writeDb = async (data) => { await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2)); };

// --- 구글 드라이브 인증 로직 ---
async function loadClient() {
    try {
        const credentials = JSON.parse(await fs.readFile(OAUTH_CRED_PATH));
        const { client_secret, client_id, redirect_uris } = credentials.web;
        oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        try {
            const token = JSON.parse(await fs.readFile(TOKEN_PATH));
            oAuth2Client.setCredentials(token);
            console.log('기존 인증 토큰을 성공적으로 불러왔습니다.');
            isGoogleReady = true;
        } catch (err) {
            console.log('기존 토큰이 없습니다. 서버 관리자 인증이 필요합니다.');
            const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive'] });
            console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
            console.log('서버 인증을 위해 아래 URL을 복사하여 웹 브라우저에 붙여넣으세요:');
            console.log(authUrl);
            console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
        }
    } catch (err) {
        console.error('OAuth credentials 파일을 읽는 데 실패했습니다.', err);
        process.exit(1);
    }
}

// --- Express 앱 설정 ---
app.use(express.json());
app.use(express.static('public'));
const upload = multer({ storage: multer.memoryStorage() });

// --- API 라우터 ---

// [수정] 구글 인증 편지를 받을 공식 우편함 주소
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    if (code) {
        try {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
            isGoogleReady = true;
            console.log('토큰이 성공적으로 저장되었습니다. 이제 서버가 정상 작동합니다.');
            res.send('<h1>인증 성공!</h1><p>이 창을 닫고 원래 사이트로 돌아가세요. 서버가 곧 재시작됩니다.</p>');
        } catch (error) {
            console.error('토큰 교환 중 오류:', error);
            res.status(500).send('인증 중 오류가 발생했습니다.');
        }
    } else {
        res.status(400).send('인증 코드를 찾을 수 없습니다.');
    }
});

// [수정] 업로드 전, 구글 인증이 완료되었는지 확인
app.post('/upload', upload.single('image'), async (req, res) => {
    if (!isGoogleReady) {
        return res.status(503).json({ message: '서버가 아직 Google Drive에 연결되지 않았습니다. 잠시 후 다시 시도해주세요.' });
    }
    // ... 이하 업로드 로직은 이전과 동일 ...
    try {
        const { file } = req;
        const { studentId, studentName, classNumber } = req.body;
        if (!file || !studentId || !studentName || !classNumber) return res.status(400).json({ message: '정보가 누락되었습니다.' });
        const folderId = GOOGLE_DRIVE_FOLDER_IDS[classNumber];
        if (!folderId || folderId.includes('_ID')) return res.status(500).json({ message: '서버에 폴더 ID가 설정되지 않았습니다.' });
        const drive = google.drive({ version: 'v3', auth: oAuth2Client });
        const fileMetadata = { name: `${studentId}_${studentName}_${file.originalname}`, parents: [folderId] };
        const bufferStream = new PassThrough();
        bufferStream.end(file.buffer);
        const media = { mimeType: file.mimetype, body: bufferStream };
        const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, name, webViewLink, thumbnailLink' });
        await drive.permissions.create({ fileId: response.data.id, requestBody: { role: 'reader', type: 'anyone' } });
        const db = await readDb();
        const newUpload = { id: response.data.id, fileName: response.data.name, studentName: studentName, classNumber: classNumber, url: `https://drive.google.com/uc?export=view&id=${response.data.id}`, timestamp: new Date().toISOString() };
        db.uploads.push(newUpload);
        await writeDb(db);
        res.status(200).json({ message: '파일이 성공적으로 업로드되었습니다.', upload: newUpload });
    } catch (error) {
        console.error('업로드 중 오류 발생:', error.message);
        res.status(500).json({ message: '서버에서 오류가 발생했습니다.' });
    }
});

// --- 나머지 API (이전과 동일) ---
app.post('/api/login', async (req, res) => { try { const { studentId, studentName, password } = req.body; if (studentId === '00000' && studentName === '최현종' && password === 'donggwangedu') { return res.json({ success: true, isAdmin: true, admin: { name: '최현종' } }); } const students = await readStudentsDb(); const student = students.find(s => s.id === studentId && s.name === studentName); if (!student) return res.status(404).json({ message: '학번 또는 이름을 찾을 수 없습니다.' }); if (student.password !== password) return res.status(401).json({ message: '비밀번호가 일치하지 않습니다.' }); const classNumber = student.id.substring(2, 3); res.json({ success: true, isAdmin: false, requiresPasswordChange: password === '1111', student: { id: student.id, name: student.name, classNumber } }); } catch (error) { res.status(500).json({ message: '로그인 중 서버 오류가 발생했습니다.' }); } });
app.post('/api/change-password', async (req, res) => { try { const { studentId, newPassword } = req.body; let students = await readStudentsDb(); const studentIndex = students.findIndex(s => s.id === studentId); if (studentIndex === -1) return res.status(404).json({ message: '학생 정보를 찾을 수 없습니다.' }); students[studentIndex].password = newPassword; await writeStudentsDb(students); res.json({ success: true, message: '비밀번호가 성공적으로 변경되었습니다.' }); } catch (error) { res.status(500).json({ message: '비밀번호 변경 중 서버 오류가 발생했습니다.' }); } });
app.get('/api/admin/students', async (req, res) => { try { const students = await readStudentsDb(); const studentsWithoutPasswords = students.map(({ password, ...student }) => student); res.json(studentsWithoutPasswords); } catch (error) { res.status(500).json({ message: '학생 목록을 불러오는 중 서버 오류가 발생했습니다.' }); } });
app.post('/api/admin/reset-password', async (req, res) => { try { const { studentId } = req.body; if (!studentId) return res.status(400).json({ message: '학생 학번이 필요합니다.' }); let students = await readStudentsDb(); const studentIndex = students.findIndex(s => s.id === studentId); if (studentIndex === -1) return res.status(404).json({ message: '해당 학생을 찾을 수 없습니다.' }); students[studentIndex].password = '1111'; await writeStudentsDb(students); res.json({ success: true, message: `${students[studentIndex].name} 학생의 비밀번호가 초기화되었습니다.` }); } catch (error) { res.status(500).json({ message: '비밀번호 초기화 중 서버 오류가 발생했습니다.' }); } });
app.get('/api/admin/all-images', async (req, res) => { try { const db = await readDb(); res.json(db.uploads); } catch (error) { res.status(500).json({ message: '전체 이미지 목록을 불러오는 중 서버 오류가 발생했습니다.' }); } });
app.get('/api/images/:classNumber', async (req, res) => { const { classNumber } = req.params; const db = await readDb(); const classImages = db.uploads.filter(upload => upload.classNumber === classNumber); classImages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); res.json(classImages); });


// --- 서버 시작 ---
loadClient().then(() => {
    app.listen(port, () => {
        console.log(`\n서버가 http://localhost:${port} 에서 실행 중입니다.`);
    });
}).catch(err => console.error('클라이언트 로드 실패:', err));
