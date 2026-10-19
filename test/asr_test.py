"""用 Windows 自带中文 TTS 生成测试语音，再喂给本地 Vosk，比对认得对不对。
   这样不用真人录音也能验证整条链路。"""
import base64
import io
import json
import os
import subprocess
import sys
import urllib.request
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, '_asr')
os.makedirs(OUT, exist_ok=True)

# 挑的都是老人真会说的句子：短、口语、带人名地名和年份
PHRASES = [
    "我年轻时候在国棉三厂上班",
    "老伴秀兰走了三年了",
    "我老家在山东临沂",
    "今天天气不错，我想出去走走",
    "孙子什么时候回来吃饭",
]

PS = r'''
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$s.Rate = -1
$s.SetOutputToWaveFile('{wav}')
$s.Speak('{text}')
$s.Dispose()
'''

print("  生成测试语音…")
wavs = []
for i, t in enumerate(PHRASES):
    wav = os.path.join(OUT, f't{i}.wav')
    if not os.path.exists(wav):
        script = PS.format(wav=wav.replace('\\', '\\\\'), text=t)
        p = subprocess.run(['powershell', '-NoProfile', '-Command', script],
                           capture_output=True, text=True)
        if p.returncode != 0 or not os.path.exists(wav):
            print(f'    [{i}] 生成失败: {p.stderr[:120]}')
            continue
    wavs.append((wav, t))
    print(f'    [{i}] {t}  ({os.path.getsize(wav) / 1024:.0f} KB)')


def to_pcm16k(path):
    """读 WAV → 单声道 16 位 → 重采样到 16 kHz"""
    with wave.open(path, 'rb') as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        a = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif sw == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128.0
    else:
        a = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if sr != 16000:                       # 线性插值重采样，够用了
        idx = np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr))
        a = np.interp(idx, np.arange(len(a)), a).astype(np.float32)
    return (np.clip(a, -1, 1) * 32767).astype('<i2').tobytes()


def post(path, obj, timeout=120):
    body = json.dumps(obj).encode()
    req = urllib.request.Request(f'http://127.0.0.1:3789{path}', data=body,
                                 headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


print("\n  === 喂给本地 Vosk ===")
hit = 0
for wav, truth in wavs:
    pcm = to_pcm16k(wav)
    t0 = __import__('time').time()
    try:
        r = post('/api/listen', {'pcm': base64.b64encode(pcm).decode(), 'rate': 16000})
    except Exception as e:
        print(f'    ERR {e}')
        continue
    dt = (__import__('time').time() - t0) * 1000
    if not r.get('ok'):
        print(f'    [{truth}]  失败：{r.get("error")}')
        continue
    got = r.get('text', '')
    # 粗略算对：去掉标点后看有多少字命中了
    ok = sum(1 for c in set(truth) if c in got) / max(len(set(truth)), 1)
    hit += 1 if ok > 0.7 else 0
    print(f'    原句  {truth}')
    print(f'    识别  {got}')
    print(f'          音频 {r.get("audio_ms")}ms → 识别 {r.get("ms")}ms（端到端 {dt:.0f}ms），命中 {ok:.0%}')
    print()

print(f'  粗对：{hit}/{len(wavs)}')
