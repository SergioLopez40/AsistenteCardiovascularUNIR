import os
import json
import joblib
import numpy as np
import pandas as pd
from google.cloud import storage
from flask import Flask, request

app = Flask(__name__)

# Configurar variables globales
BUCKET_NAME = "datasets-cardiovasculares"
MODEL_PATH = "models/xgboost_model.pkl"
SCALER_PATH = "models/scaler1.pkl"

# Iniciar cliente de almacenamiento
client = storage.Client()
bucket = client.bucket(BUCKET_NAME)

# Función para descargar archivos desde Cloud Storage
def descargar_archivo(blob_name, local_path):
    """Descarga un archivo desde Cloud Storage y verifica que se haya descargado correctamente."""
    blob = bucket.blob(blob_name)
    blob.download_to_filename(local_path)
    if not os.path.exists(local_path) or os.path.getsize(local_path) == 0:
        raise RuntimeError(f"Error: {blob_name} no se descargó correctamente de Cloud Storage.")

# Descargar y cargar el modelo y scaler
descargar_archivo(MODEL_PATH, "/tmp/xgboost_model.pkl")
descargar_archivo(SCALER_PATH, "/tmp/scaler1.pkl")

xgb_model = joblib.load("/tmp/xgboost_model.pkl")
scaler = joblib.load("/tmp/scaler1.pkl")

print("Modelo XGBoost cargado correctamente.")

@app.route('/predict', methods=['POST'])
def predict(request):
    data = request.get_json()
    
    # Calcular el IMC
    height_m = data["height"] / 100  # Convertir a metros
    imc = data["weight"] / (height_m ** 2)

    # Codificar `gender` (0 o 1)
    gender_encoded = 1 if data["gender"] == 2 else 0

    # Codificar `cholesterol` y `gluc` con Ordinal Encoding
    cholesterol_encoded = data["cholesterol"] - 1
    gluc_encoded = data["gluc"] - 1

    # Crear un DataFrame con los datos procesados
    input_data = pd.DataFrame([[
        data["age"], 
        data["ap_hi"], 
        data["ap_lo"], 
        imc, 
        gender_encoded, 
        cholesterol_encoded, 
        gluc_encoded, 
        data["smoke"], 
        data["alco"], 
        data["active"]
    ]], columns=['age', 'ap_hi', 'ap_lo', 'imc', 'gender_encoded', 
                 'cholesterol_encoded', 'gluc_encoded', 'smoke', 'alco', 'active'])

    # Verificar el orden de columnas en el scaler
    print("Orden de columnas en el scaler:", scaler.feature_names_in_)
    
    # Asegurar que las columnas estén en el orden correcto
    expected_columns = list(scaler.feature_names_in_)
    input_data = input_data[expected_columns]
    
    # Asegurar que todas las columnas sean float64
    input_data = input_data.astype(np.float64)
    
    # Verificar antes de transformar
    print("Tipos de datos en input_data:\n", input_data.dtypes)
    print("Valores de input_data antes de escalar:\n", input_data.head())

    # Aplicar escalado a las variables numéricas
    input_data_scaled = scaler.transform(input_data)

    # Predecir con el modelo
    prediction = xgb_model.predict(input_data_scaled)

    # Devolver resultado en formato JSON
    return json.dumps({"prediccion": int(prediction[0])})

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=8080, debug=True)
