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
MODEL_PATH = "models"
DATASET_PATH = "dataset_clustering.csv"

# Diccionario para One-Hot Encoding de 'Type'
type_encoding = {
    0: [0, 0, 0, 0],  # Default 
    1: [1, 0, 0, 0],  # Cardio
    2: [0, 1, 0, 0],  # Plyometrics
    3: [0, 0, 1, 0],  # Strength
    4: [0, 0, 0, 1]   # Stretching
}

# Iniciar cliente de almacenamiento
client = storage.Client()
bucket = client.bucket(BUCKET_NAME)

# Función para descargar y validar archivos
def descargar_archivo(blob_name, local_path):
    """Descarga un archivo desde Cloud Storage y verifica que se haya descargado correctamente."""
    blob = bucket.blob(blob_name)
    blob.download_to_filename(local_path)

    if not os.path.exists(local_path) or os.path.getsize(local_path) == 0:
        raise RuntimeError(f"Error: {blob_name} no se descargó correctamente de Cloud Storage.")

# Descargar y validar scaler.pkl
descargar_archivo(f"{MODEL_PATH}/scaler.pkl", "/tmp/scaler.pkl")
scaler = joblib.load("/tmp/scaler.pkl")
print("Scaler cargado correctamente.")

# Descargar y validar kmeans_model.pkl
descargar_archivo(f"{MODEL_PATH}/kmeans_model.pkl", "/tmp/kmeans_model.pkl")
kmeans = joblib.load("/tmp/kmeans_model.pkl")
print("Modelo K-Means cargado correctamente.")

# Descargar y cargar dataset con clusters
descargar_archivo(DATASET_PATH, "/tmp/dataset_clusterizado.csv")
df = pd.read_csv("/tmp/dataset_clusterizado.csv")
df_info = df[["Title", "Desc"]].copy()

@app.route('/predict', methods=['POST'])
def predict(request):
    data = request.get_json()

    # Obtener top_n (cantidad de ejercicios solicitados, default = 3)
    top_n = data.get("top_n", 3)

    # Transformar `Type` a One-Hot Encoding
    type_vector = type_encoding.get(data.get("Type", 0), [0, 0, 0, 0])

    # Crear vector de entrada con las columnas correctas
    input_data = np.array([[
        data["Cardiovascular_Safe"],
        data["BodyPart_Category_Encoded"],
        data["Equipment_Encoded"],
        data["Level"]
    ] + type_vector])

    # Normalizar la entrada
    input_data_scaled = scaler.transform(input_data)

    # Predecir el cluster
    cluster_pred = kmeans.predict(input_data_scaled)[0]

    # Filtrar ejercicios del mismo cluster
    ejercicios_cluster = df[df["Cluster"] == cluster_pred].copy()

    # Calcular distancia entre el usuario y los ejercicios del cluster
    ejercicios_cluster["Distancia"] = np.linalg.norm(
        scaler.transform(ejercicios_cluster[[
            "Cardiovascular_Safe", "BodyPart_Category_Encoded",
            "Equipment_Encoded", "Level", "Type_Cardio",
            "Type_Plyometrics", "Type_Strength", "Type_Stretching"
        ]]) - input_data_scaled, axis=1
    )

    # Ajustar top_n si hay menos ejercicios en el cluster
    top_n = min(top_n, len(ejercicios_cluster))

    # Ordenar por cercanía al usuario y seleccionar los `top_n` mejores
    ejercicios_recomendados = ejercicios_cluster.sort_values(by="Distancia").head(top_n)

    # Obtener títulos y descripciones de los ejercicios recomendados
    recomendaciones = df_info.loc[ejercicios_recomendados.index, ["Title", "Desc"]].to_dict(orient="records")

    return json.dumps({"recomendaciones": recomendaciones})

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=8080, debug=True)
