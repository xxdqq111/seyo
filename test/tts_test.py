"""本地语音合成自测：调 /api/say 拿 WAV，检查时长、采样率、能不能真解码。
   不需要人耳，只验"合成出来的是一段像样的音频"。"""
import base64
import io
import json
import os
import struct
import sys
import time
import urllib.request
import wave

BASE = os.environ.get('SEYO_BASE', 'http://127.0.0.1:3789')

PHRASES = [
    '爷爷，我来了，您坐着歇会儿。',
    '您上回说纺织厂挡车工的事，我一直记着。',
    '三厂那会儿一天站八个钟头，累不累啊。',
]


def post(path, obj, timeout=180):
    body = json.dumps(obj).encode()
    req = urllib.request.Request(BASE + path, data=body,
                                 headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=timeout)


print('  先把服务叫醒（第一次要加载 115 MB 的模型）…')
t0 = time.time()
try:
    with urllib.request.urlopen(BASE + '/api/say', timeout=60) as r:
        st = json.loads(r.read())
except Exception as e:
    print(f'  拿不到状态：{e}')
    sys.exit(1)
print(f'  引擎 {st.get("engine")}  端口 {st.get("ttsPort")}  运行中 {st.get("running")}')

if not st.get('ttsModelDir') or not os.path.isdir(st['ttsModelDir']):
    print(f'  模型目录不存在：{st.get("ttsModelDir")}')
    print('  下载 vits-zh-hf-fanchen-wnj 解压到那儿再测')
    sys.exit(1)

print('\n  === 合成 ===')
ok_cnt = 0
for i, text in enumerate(PHRASES):
    t = time.time()
    try:
        res = post('/api/say', {'text': text, 'speed': 1.0})
        wav = res.read()
    except urllib.error.HTTPError as e:
        print(f'    [{i}] 失败 {e.code}：{e.read()[:200].decode("utf-8", "ignore")}')
        continue
    except Exception as e:
        print(f'    [{i}] 失败：{e}')
        continue
    dt = (time.time() - t) * 1000
    ms = res.headers.get('X-Seyo-Ms')
    audio_ms = res.headers.get('X-Seyo-Audio-Ms')

    # 真的把它当 WAV 解开，确认不是空壳
    try:
        with wave.open(io.BytesIO(wav), 'rb') as w:
            ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            frames = w.readframes(min(n, sr * 2))     # 只读前 2 秒，够算有没有声音
    except Exception as e:
        print(f'    [{i}] WAV 解不开：{e}  （{len(wav)} 字节）')
        continue

    import array
    a = array.array('h')
    a.frombytes(frames)
    peak = max((abs(x) for x in a), default=0)
    rms = (sum(x * x for x in a) / max(1, len(a))) ** 0.5

    dur = n / sr
    verdict = 'OK' if (dur > 0.4 and peak > 1000) else '声音太小/太短'
    if verdict == 'OK':
        ok_cnt += 1
    print(f'    [{i}] {text}')
    print(f'          WAV {len(wav) / 1024:.0f} KB  {ch} 声道 {sw * 8} 位 {sr} Hz  {dur:.2f} 秒')
    print(f'          合成 {ms} ms（端到端 {dt:.0f} ms）  峰值 {peak}  RMS {rms:.0f}   → {verdict}')

print(f'\n  通过 {ok_cnt}/{len(PHRASES)}')
if ok_cnt == 0:
    sys.exit(1)

# 顺手把第一句存下来，人可以双击听
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_tts_sample.wav')
try:
    res = post('/api/say', {'text': PHRASES[0], 'speed': 1.0})
    with open(out, 'wb') as f:
        f.write(res.read())
    print(f'  样例已存：{out}')
except Exception as e:
    print(f'  样例没存成：{e}')
