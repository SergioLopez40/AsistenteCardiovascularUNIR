const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const admin = require('firebase-admin');
const Twilio = require('twilio');

const sessionCache = {}; // Caché en memoria para almacenar el estado del usuario

// 🔹 Inicializar Firebase
if (!admin.apps.length) {
    console.log("🔹 Inicializando Firebase...");
    try {
        const openFile = Runtime.getAssets()['/firebase-admin.json'].open;
        const serviceAccount = JSON.parse(openFile());
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: "asistente-cardiovascular",
            databaseURL: `https://firestore.googleapis.com/v1/projects/asistente-cardiovascular/databases/(usuarios)/documents`
        });
        console.log(" Firebase inicializado.");
    } catch (error) {
        console.error("Error cargando credenciales de Firebase:", error);
    }
}

const db = admin.firestore();
db.settings({ databaseId: "usuarios" });

// Función para obtener Access Token de Google Cloud
async function getAccessToken() {
    try {
        console.log("Obteniendo Access Token...");
        const openFile = Runtime.getAssets()['/asistente-cardiovascular.json'].open;
        const credentials = JSON.parse(openFile());

        const auth = new GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        let tokenResponse = await client.getAccessToken();

        console.log(` Access Token obtenido: ${tokenResponse.token}`);
        return tokenResponse.token;
    } catch (error) {
        console.error(" Error obteniendo el Access Token:", error);
        return null;
    }
}

//  Función para obtener usuario desde Firestore (consulta solo si no está en caché)
async function getUserById(userId) {
    if (sessionCache[userId]?.userData) {
        console.log(` Usando datos en caché para usuario ${userId}`);
        return sessionCache[userId].userData;
    }

    console.log(` Buscando usuario en Firestore con ID: ${userId}...`);
    const userRef = db.collection('usuarios').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
        console.log(" Usuario NO encontrado en Firestore.");
        return null;
    }

    const userData = userDoc.data();
    sessionCache[userId] = { userData, requiereRegistro: false }; // Cachear usuario encontrado
    console.log(" Usuario encontrado:", userData);
    return userData;
}

// 🔹 Función para enviar mensaje a Dialogflow CX y capturar el intent
async function sendMessageToDialogflow(sender, message, requiereRegistro) {
    let accessToken = await getAccessToken();
    if (!accessToken) throw new Error(" Access Token no obtenido.");

    let projectId = "asistente-cardiovascular";
    let agentId = "d7811103-b2a0-421f-9a72-1d63f1c72736";
    let dialogflowUrl = `https://us-central1-dialogflow.googleapis.com/v3/projects/${projectId}/locations/us-central1/agents/${agentId}/sessions/${sender}:detectIntent`;

    let requestData = {
        queryInput: {
            text: { text: message },
            languageCode: "es"
        },
        queryParams: {
            parameters: {
                requiereRegistro: requiereRegistro
            }
        }
    };

    console.log(" Enviando mensaje a Dialogflow CX...");
    let response = await axios.post(dialogflowUrl, requestData, {
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" }
    });

    console.log(` Respuesta de Dialogflow CX: ${JSON.stringify(response.data)}`);
    console.log(" Contenido de response.data:", JSON.stringify(response.data, null, 2));
    console.log(" queryResult:", JSON.stringify(response.data.queryResult, null, 2));
    console.log(" Propiedades de queryResult:", Object.keys(response.data.queryResult));



    //  Capturar el intent detectado
    let intent = response.data.queryResult.intent?.displayName || "Desconocido";
    console.log(` Intent detectado: ${intent}`);

    //  Capturar los parámetros recibidos de Dialogflow CX
    let parameters = response.data.queryResult.parameters || {};

    //  Capturar los mensajes de respuesta
    let botResponses = response.data.queryResult.responseMessages || [];
    let messages = botResponses.map(msg => msg?.text?.text?.[0]).filter(text => text);

    return { messages, intent, parameters };
}

// Función para manejar cada intención detectada en Dialogflow
async function manejarIntent(intent, sender, parameters) {
    switch (intent) {
        case "ConfirmarDatos":
            return  [await registrarUsuario(sender, parameters)];
        case "ConfirmarMonitoreo":
            return [await obtenerDatosHuawei(sender)];
        case "GenerarRutina":
            return [await obtenerRecomendacionAI(sender, parameters)];
        case "Evaluar riesgo":
            return [await obtenerEstadoSalud(sender)];
        case "ConfirmacionDesvinculacion":
            return [await eliminarUsuario(sender)];
        default:
            return null;
    }
}

//  Función principal que maneja la solicitud de Twilio
exports.handler = async function(context, event, callback) {
    try {
        let userMessage = event.Body;
        let sender = event.From.replace("whatsapp:", "").replace("+", "").trim();
        console.log(` Mensaje recibido de ${sender}: ${userMessage}`);

        //  1 Verificar si el usuario está en caché
        if (!(sender in sessionCache)) {
            let userData = await getUserById(sender);
            sessionCache[sender] = { userData, requiereRegistro: !userData };
        }

        //  2️ Si necesita registro, solo enviar "INTENT_REGISTRO" una vez
        if (sessionCache[sender].requiereRegistro) {
            console.log("Usuario no registrado, redirigiendo a Registro...");
            userMessage = "INTENT_REGISTRO";
            sessionCache[sender].requiereRegistro = false; // Evitar que se repita en cada mensaje
        }

        //  3️ Enviar mensaje a Dialogflow CX
        let { messages, intent, parameters } = await sendMessageToDialogflow(sender, userMessage, sessionCache[sender].requiereRegistro);
        console.log(`Respuesta del bot: ${messages}`);

        // Ejecutar acción si hay un intent relevante
        let intentResponse = await manejarIntent(intent, sender, parameters);
        if (intentResponse) {
            messages = [...messages, ...intentResponse.flat()];
        }

        // 5️ Responder en Twilio con espera entre mensajes
        const twiml = new Twilio.twiml.MessagingResponse();

        console.log(`Total de mensajes a enviar: ${messages.length}`);
        for (let i = 0; i < messages.length; i++) {
            let msg = messages[i];
        
            console.log(`Procesando mensaje ${i + 1}/${messages.length}:`, JSON.stringify(msg));
        
            try {
                if (typeof msg === "string" && msg.startsWith("http")) { 
                    console.log(` Enviando imagen con URL: ${msg}`);
                    let mediaMessage = twiml.message();
                    mediaMessage.media(msg);
                } else if (typeof msg === "string") {  
                    console.log(`Enviando mensaje de texto: ${msg}`);
                    twiml.message(msg);
                }
            } catch (error) {
                console.error(` Error al procesar el mensaje ${i + 1}:`, error);
            }
        
            if (i < messages.length - 1) {
                console.log(` Esperando 3 segundos antes del próximo mensaje...`);
                //await sleep(1);
            }
        }

        console.log(` Todos los mensajes han sido procesados.`);
        callback(null, twiml);

    } catch (error) {
        console.error("Error en el procesamiento:", error);
        callback(error);
    }
};

// 🔹 Función para registrar usuario en Firebase
async function registrarUsuario(sender, parameters) {
    try {
        console.log(` Registrando usuario ${sender} en Firestore...`);

        const userData = {
            name: parameters.name?.name || parameters.name || "Desconocido",
            age: parameters.age || 0,
            gender: parameters.gender || "N/A",
            height: parameters.height || 0,
            weight: parameters.weight || 0,
            ap_hi: parameters.ap_hi || 0,
            ap_lo: parameters.ap_lo || 0,
            cholesterol: parameters.cholesterol || 0,
            gluc: parameters.gluc || 0,
            smoke: parameters.smoke || false,
            alco: parameters.alco || false,
            active: parameters.active || false,
            registeredAt: new Date().toISOString()
        };

        await db.collection("usuarios").doc(sender).set(userData);
        console.log(` Usuario ${sender} registrado correctamente.`);

        //  Actualizar estado en caché
        sessionCache[sender] = { userData, requiereRegistro: false };

        return "Tu registro ha sido completado con éxito. ¡Bienvenido!";
    } catch (error) {
        console.error(" Error al registrar usuario:", error);
        return " Hubo un problema al registrar tus datos. Inténtalo más tarde.";
    }
}

// 🔹 Función para eliminar usuario de Firebase cuando confirma la desvinculación
async function eliminarUsuario(sender) {
    try {
        console.log(` Eliminando usuario ${sender} de Firestore...`);
        await db.collection("usuarios").doc(sender).delete();
        console.log(` Usuario ${sender} eliminado correctamente.`);
        
        //  Restablecer el estado en caché
        delete sessionCache[sender];

        return " Tu cuenta ha sido eliminada correctamente. Si deseas volver, regístrate de nuevo.";
    } catch (error) {
        console.error(" Error al eliminar usuario:", error);
        return " Hubo un problema al eliminar tu cuenta. Inténtalo más tarde.";
    }
}

// 🔹 Función para obtener recomendaciones de ejercicio desde el modelo AI
async function obtenerRecomendacionAI(sender, parameters) {
    try {
        console.log(`Solicitando recomendaciones de ejercicio para ${sender}...`);

        // Datos de entrada para la recomendación
        const requestData = {
            "Cardiovascular_Safe": parameters.cardio,
            "BodyPart_Category_Encoded": parameters.bodypart,
            "Equipment_Encoded": parameters.equipment,
            "Level": parameters.level,
            "Type": parameters.typeexercise,
            "top_n": parameters.numberexercises || 1 
        };

        // Llamar al endpoint de recomendaciones
        const response = await axios.post(
            "https://us-central1-asistente-cardiovascular.cloudfunctions.net/predict-exercises",
            requestData,
            { headers: { "Content-Type": "application/json" } }
        );

        //  Inspeccionar solo la respuesta de la API de recomendaciones
        console.log(" Respuesta del servicio de recomendaciones:", JSON.stringify(response.data, null, 2));

        if (!response.data || !response.data.recomendaciones) {
            console.error(" Respuesta inválida del servicio de AI.");
            return " No se pudieron obtener recomendaciones en este momento.";
        }

        // Procesar recomendaciones
        const recomendaciones = response.data.recomendaciones;
        console.log(` Se recibieron ${recomendaciones.length} recomendaciones.`);

        //  Inspeccionar las recomendaciones específicas
        console.log(" Recomendaciones sin procesar:", JSON.stringify(recomendaciones, null, 2));

        // Preparar mensajes en formato separado para WhatsApp
        let mensajes = [];
        for (const rec of recomendaciones) {
            let sanitizedTitle = rec.Title.toLowerCase()
                .replace(/\s+/g, '_')  // Reemplazar espacios con "_"
                .replace(/[^a-z0-9_]/g, ''); // Eliminar caracteres no alfanuméricos

            let imageUrl = `https://periwinkle-beagle-1321.twil.io/assets/${sanitizedTitle}.jpg`;

            console.log(` Generando URL de imagen: ${imageUrl}`);

            // 📌 Agregar mensajes en texto plano
            mensajes.push(`💪 Ejercicio: *${rec.Title}*`);
            mensajes.push(`📖 Descripción: ${rec.Desc}`);
            mensajes.push(imageUrl);

            console.log(` Mensajes añadidos: ${mensajes}`);
        }

        return mensajes; 
    } catch (error) {
        console.error(" Error obteniendo recomendaciones de AI:", error);
        return [" Hubo un problema obteniendo tus recomendaciones. Inténtalo más tarde."];
    }
}

function sanitizeForTwilio(text) {
    if (typeof text !== "string") {
        console.warn(" Valor no string en sanitizeForTwilio:", text);
        text = String(text); 
    }
    
    return text
        .normalize("NFKD") 
        .replace(/[\u200B-\u200F\uFEFF\u00A0]/g, '') 
        .replace(/[“”]/g, '"') 
        .replace(/[‘’]/g, "'") 
        .replace(/&/g, "&amp;") 
        .replace(/</g, "&lt;") 
        .replace(/>/g, "&gt;") 
        .replace(/"/g, "&quot;") 
        .replace(/'/g, "&apos;") 
        .replace(/[\x00-\x1F\x7F]/g, ''); 
}

// Función para pausar la ejecución por un tiempo determinado
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Función para obtener el estado de salud desde el modelo AI
async function obtenerEstadoSalud(sender) {
    try {
        console.log(` Solicitando estado de salud para ${sender}...`);

        // Obtener datos del usuario desde cache o Firestore
        const userData = await getUserById(sender);
        if (!userData) {
            console.error(` No se encontraron datos para el usuario ${sender}.`);
            return [" No se pudieron obtener tus datos de salud. Regístrate primero."];
        }

        // Datos de entrada para la predicción de riesgo cardiovascular
        const requestData = {
            "age": userData.age || 0,
            "ap_hi": userData.ap_hi || 0,
            "ap_lo": userData.ap_lo || 0,
            "height": userData.height || 0,
            "weight": userData.weight || 0,
            "gender": userData.gender || 0,
            "cholesterol": userData.cholesterol || 0,
            "gluc": userData.gluc || 0,
            "smoke": userData.smoke ? 1 : 0,
            "alco": userData.alco ? 1 : 0,
            "active": userData.active ? 1 : 0
        };

        // Llamar al endpoint de predicción de riesgo cardiovascular
        const response = await axios.post(
            "https://us-central1-asistente-cardiovascular.cloudfunctions.net/predict-cardio",
            requestData,
            { headers: { "Content-Type": "application/json" } }
        );

        console.log(" Respuesta del servicio de predicción:", JSON.stringify(response.data, null, 2));

        if (!response.data || !response.data.prediccion) {
            console.error(" Respuesta inválida del servicio de predicción.");
            return [" No se pudo determinar tu estado de salud en este momento."];
        }

        // Procesar la respuesta del modelo
        const estadoSalud = response.data.prediccion;
        console.log(`Predicción recibida: ${estadoSalud}`);

        //  Formatear la respuesta para WhatsApp
        let mensajes = [];
        if (estadoSalud === 1) {
            mensajes.push("Resultado: El modelo ha predecido que si tienes riesgo cardiovascular. Te recomiendo consultar con tu médico. Yo me encargare de generarte rutinas adaptadas a este resultado.");
        } else {
            mensajes.push("Resultado:*Tu riesgo cardiovascular es BAJO. Sigue manteniendo hábitos saludables.");
        }

        return mensajes;
    } catch (error) {
        console.error(" Error obteniendo estado de salud:", error);
        return [" Hubo un problema al obtener tu estado de salud. Inténtalo más tarde."];
    }
}

//  Función para obtener datos de Huawei (Incluye autenticación)
async function obtenerDatosHuawei(sender) {
    try {
        let userData = sessionCache[sender]?.userData;
        if (!userData) {
            userData = await getUserById(sender);
            if (!userData) return " No se encontraron datos del usuario.";
        }

        //  1️ Si el usuario no tiene tokens, solicitar autenticación
        if (!userData.huawei_access_token || !userData.huawei_refresh_token) {
            const authUrl = `${process.env.HUAWEI_AUTH_URL}?client_id=${process.env.HUAWEI_CLIENT_ID}&redirect_uri=${process.env.HUAWEI_REDIRECT_URI}&response_type=code&scope=${process.env.HUAWEI_SCOPE}`;
            return `Para conectar tu Huawei Watch, ingresa a: ${authUrl}`;
        }

        //  2️ Si tiene token, solicitar datos de Huawei
        console.log(` Obteniendo datos de salud desde Huawei para ${sender}...`);
        const response = await axios.get("https://healthapi.cloud.huawei.com/data", {
            headers: { Authorization: `Bearer ${userData.huawei_access_token}` }
        });

        console.log(" Datos recibidos de Huawei:", response.data);

        //  3️ Extraer y validar signos vitales
        const heartRate = response.data.heart_rate;
        const bloodPressure = response.data.blood_pressure;
        const spo2 = response.data.spo2;

        let alertas = validarSignosVitales(heartRate, bloodPressure, spo2);

        return alertas.length > 0 ? alertas.join("\n") : " Todos tus signos vitales están dentro de los rangos normales.";
    } catch (error) {
        console.error(" Error obteniendo datos de Huawei:", error);
        return " No se pudo obtener datos de tu Huawei Watch.";
    }
}

//  Función para intercambiar el código de autorización por tokens de Huawei
async function intercambiarCodigoPorToken(sender, code) {
    try {
        console.log(` Intercambiando código por token para ${sender}...`);
        const response = await axios.post("https://oauth-login.cloud.huawei.com/oauth2/v3/token", {
            grant_type: "authorization_code",
            client_id: process.env.HUAWEI_CLIENT_ID,
            client_secret: process.env.HUAWEI_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.HUAWEI_REDIRECT_URI
        });

        console.log(" Tokens obtenidos:", response.data);

        const { access_token, refresh_token } = response.data;

        // Guardar los tokens en Firestore y en la caché
        await db.collection("usuarios").doc(sender).update({
            huawei_access_token: access_token,
            huawei_refresh_token: refresh_token
        });

        sessionCache[sender].userData.huawei_access_token = access_token;
        sessionCache[sender].userData.huawei_refresh_token = refresh_token;

        return " Conexión con Huawei Watch exitosa. Ahora puedes obtener tus datos de salud.";
    } catch (error) {
        console.error(" Error intercambiando código por token:", error);
        return " No se pudo completar la conexión con Huawei. Inténtalo nuevamente.";
    }
}

//  Función para renovar el token de Huawei cada hora
async function renovarTokenHuawei(sender) {
    try {
        let userData = sessionCache[sender]?.userData;
        if (!userData || !userData.huawei_refresh_token) return;

        console.log(` Renovando token de Huawei para ${sender}...`);
        const response = await axios.post("https://oauth-login.cloud.huawei.com/oauth2/v3/token", {
            grant_type: "refresh_token",
            client_id: process.env.HUAWEI_CLIENT_ID,
            client_secret: process.env.HUAWEI_CLIENT_SECRET,
            refresh_token: userData.huawei_refresh_token
        });

        const newAccessToken = response.data.access_token;

        //  1️ Guardar nuevo access_token en Firestore y caché
        userData.huawei_access_token = newAccessToken;
        sessionCache[sender].userData.huawei_access_token = newAccessToken;

        await db.collection("usuarios").doc(sender).update({ huawei_access_token: newAccessToken });

        console.log(" Token de Huawei renovado exitosamente.");
    } catch (error) {
        console.error(" Error renovando token de Huawei:", error);
    }
}

function validarSignosVitales(heartRate, bloodPressure, spo2) {
    let alertas = [];
    if (heartRate < 50 || heartRate > 120) {
        alertas.push(`Alerta: Tu frecuencia cardiaca es anormal (${heartRate} BPM).`);
    }
    if (bloodPressure.systolic > 140 || bloodPressure.diastolic > 90) {
        alertas.push(`Alerta: Tu presión arterial está alta (${bloodPressure.systolic}/${bloodPressure.diastolic}).`);
    }
    if (spo2 < 90) {
        alertas.push(`Alerta: Tu nivel de oxígeno en sangre es bajo (${spo2}%).`);
    }
    return alertas;
}

// 🔹 Intervalo para obtener datos de Huawei cada 5 minutos
setInterval(async () => {
    console.log(" Ejecutando monitoreo de signos vitales...");
    for (let sender in sessionCache) {
        let alertas = await obtenerDatosHuawei(sender);
        if (alertas.length > 0) {
            console.log(` Enviando alerta a ${sender}:`, alertas);
        }
    }
}, 5 * 60 * 1000);