const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs').promises;
const { PassThrough } = require('stream');
const http = require('http');
const url = require('url');
const destroyer = require('server-destroy');

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
        } catch (err) {
            console.log('기존 토큰이 없습니다. 새로운 토큰을 발급받아야 합니다.');
            await getNewToken(oAuth2Client);
        }
    } catch (err) {
        console.error('OAuth credentials 파일을 읽는 데 실패했습니다.', err);
        process.exit(1);
    }
}

async function getNewToken(client) {
    const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive'] });
    console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    console.log('아래 URL을 복사하여 웹 브라우저에 붙여넣고 인증을 완료하세요:');
    console.log(authUrl);
    console.log('++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++');
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const qs = new url.URL(req.url, 'http://localhost:3001').searchParams;
                const code = qs.get('code');
                res.end('인증 성공! 이 창을 닫고 콘솔을 확인하세요.');
                server.destroy();
                const { tokens } = await client.getToken(code);
                client.setCredentials(tokens);
                await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
                console.log('토큰이 성공적으로 저장되었습니다.');
                resolve(client);
            } catch (e) { reject(e); }
        }).listen(3001);
        destroyer(server);
    });
}

// --- Express 앱 설정 ---
app.use(express.json()); // JSON body-parser
app.use(express.static('public')); // 정적 파일 (index.html) 제공

// Multer 설정 (파일 업로드 처리 도구) - 라우터보다 먼저 선언되어야 합니다.
const upload = multer({ storage: multer.memoryStorage() });

// --- API 라우터 (경로) 설정 ---

// 로그인 API
app.post('/api/login', async (req, res) => {
    try {
        const { studentId, studentName, password } = req.body;
        if (studentId === '00000' && studentName === '최현종' && password === 'donggwangedu') {
            return res.json({ success: true, isAdmin: true, admin: { name: '최현종' } });
        }
        const students = await readStudentsDb();
        const student = students.find(s => s.id === studentId && s.name === studentName);
        if (!student) return res.status(404).json({ message: '학번 또는 이름을 찾을 수 없습니다.' });
        if (student.password !== password) return res.status(401).json({ message: '비밀번호가 일치하지 않습니다.' });
        const classNumber = student.id.substring(2, 3);
        res.json({ success: true, isAdmin: false, requiresPasswordChange: password === '1111', student: { id: student.id, name: student.name, classNumber } });
    } catch (error) { res.status(500).json({ message: '로그인 중 서버 오류가 발생했습니다.' }); }
});

// 비밀번호 변경 API
app.post('/api/change-password', async (req, res) => {
    try {
        const { studentId, newPassword } = req.body;
        let students = await readStudentsDb();
        const studentIndex = students.findIndex(s => s.id === studentId);
        if (studentIndex === -1) return res.status(404).json({ message: '학생 정보를 찾을 수 없습니다.' });
        students[studentIndex].password = newPassword;
        await writeStudentsDb(students);
        res.json({ success: true, message: '비밀번호가 성공적으로 변경되었습니다.' });
    } catch (error) {
        res.status(500).json({ message: '비밀번호 변경 중 서버 오류가 발생했습니다.' });
    }
});

// 관리자: 학생 목록 API
app.get('/api/admin/students', async (req, res) => {
    try {
        const students = await readStudentsDb();
        const studentsWithoutPasswords = students.map(({ password, ...student }) => student);
        res.json(studentsWithoutPasswords);
    } catch (error) {
        res.status(500).json({ message: '학생 목록을 불러오는 중 서버 오류가 발생했습니다.' });
    }
});

// 관리자: 비밀번호 초기화 API
app.post('/api/admin/reset-password', async (req, res) => {
    try {
        const { studentId } = req.body;
        if (!studentId) return res.status(400).json({ message: '학생 학번이 필요합니다.' });
        let students = await readStudentsDb();
        const studentIndex = students.findIndex(s => s.id === studentId);
        if (studentIndex === -1) return res.status(404).json({ message: '해당 학생을 찾을 수 없습니다.' });
        students[studentIndex].password = '1111';
        await writeStudentsDb(students);
        res.json({ success: true, message: `${students[studentIndex].name} 학생의 비밀번호가 초기화되었습니다.` });
    } catch (error) {
        res.status(500).json({ message: '비밀번호 초기화 중 서버 오류가 발생했습니다.' });
    }
});

// 관리자: 전체 이미지 목록 API
app.get('/api/admin/all-images', async (req, res) => {
    try {
        const db = await readDb();
        res.json(db.uploads);
    } catch (error) {
        res.status(500).json({ message: '전체 이미지 목록을 불러오는 중 서버 오류가 발생했습니다.' });
    }
});

// 학생: 반별 갤러리 API
app.get('/api/images/:classNumber', async (req, res) => {
    const { classNumber } = req.params;
    const db = await readDb();
    const classImages = db.uploads.filter(upload => upload.classNumber === classNumber);
    classImages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(classImages);
});

// 학생: 이미지 업로드 API
app.post('/upload', upload.single('image'), async (req, res) => {
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
        const newUpload = { id: response.data.id, fileName: response.data.name, studentName: studentName, classNumber: classNumber, url: response.data.thumbnailLink ? response.data.thumbnailLink.replace(/=s\d+/, '=s220') : response.data.webViewLink, timestamp: new Date().toISOString() };
        db.uploads.push(newUpload);
        await writeDb(db);
        
        res.status(200).json({ message: '파일이 성공적으로 업로드되었습니다.', upload: newUpload });
    } catch (error) {
        console.error('업로드 중 오류 발생:', error.message);
        res.status(500).json({ message: '서버에서 오류가 발생했습니다.' });
    }
});

// --- 서버 시작 ---
loadClient().then(() => {
    app.listen(port, () => {
        console.log(`\n서버가 http://localhost:${port} 에서 실행 중입니다.`);
    });
}).catch(err => console.error('클라이언트 로드 실패:', err));
