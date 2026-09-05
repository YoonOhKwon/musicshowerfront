import http.server
import socketserver
import json
import tempfile
import os
from pathlib import Path
import time

# Setup Flamingo environment
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

print("Loading Music Flamingo model (This will take a minute and ~16GB RAM/VRAM)...")
import torch
from transformers import AutoProcessor, MusicFlamingoForConditionalGeneration

MODEL_DIR = "models/research/music-flamingo"
if not Path(MODEL_DIR).is_dir():
    raise RuntimeError(f"Model directory not found at {MODEL_DIR}")

processor = AutoProcessor.from_pretrained(MODEL_DIR, local_files_only=True, trust_remote_code=False)

from transformers import BitsAndBytesConfig
quantization_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32
) if torch.cuda.is_available() else None

model = MusicFlamingoForConditionalGeneration.from_pretrained(
    MODEL_DIR,
    torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
    device_map="auto" if torch.cuda.is_available() else "cpu",
    quantization_config=quantization_config,
    local_files_only=True,
    trust_remote_code=False
)
model.eval()
print("Model loaded successfully. Starting server...")

PROMPT = (
    "Describe the musical aesthetics, vibe, cultural context, and deep emotional impression of this music. "
    "Do not just list instruments; evoke the era, the feeling (e.g. nostalgic, dreamy, energetic), and cultural aesthetic (e.g. retro, vaporwave, cyberpunk, etc.). "
    "Keep it concise and poetic but highly descriptive."
)

class FlamingoHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/analyze':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length > 30 * 1024 * 1024:
                    self.send_error(400, "File too large")
                    return
                
                # Write to a temp WAV file
                audio_data = self.rfile.read(content_length)
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp.write(audio_data)
                    tmp_path = tmp.name
                
                print("Running Flamingo inference...")
                start_t = time.time()
                conversation = [{"role": "user", "content": [
                    {"type": "text", "text": PROMPT}, 
                    {"type": "audio", "path": tmp_path}
                ]}]
                inputs = processor.apply_chat_template(
                    conversation, 
                    tokenize=True,
                    add_generation_prompt=True, 
                    return_dict=True
                ).to(model.device)
                
                if "input_features" in inputs:
                    inputs["input_features"] = inputs["input_features"].to(model.dtype)
                
                with torch.inference_mode():
                    output = model.generate(
                        **inputs, 
                        max_new_tokens=150, 
                        do_sample=False
                    )
                
                generated = output[:, inputs.input_ids.shape[1]:]
                text_out = processor.batch_decode(generated, skip_special_tokens=True)[0]
                
                print(f"Inference complete in {time.time()-start_t:.1f}s. Result: {text_out}")
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"caption": text_out}).encode('utf-8'))
            except Exception as e:
                print(f"Error: {e}")
                self.send_error(500, str(e))
            finally:
                os.remove(tmp_path)
        else:
            self.send_error(404)

if __name__ == "__main__":
    PORT = 5005
    with socketserver.TCPServer(("", PORT), FlamingoHandler) as httpd:
        print(f"Flamingo server serving at port {PORT}")
        httpd.serve_forever()
