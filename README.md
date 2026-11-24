# Taxis Los Jardines

Directorio de taxistas de la Cooperativa en Taxi Los Jardines (Quinindé). Los pasajeros ven quién está **Disponible**, **En carrera** o **No disponible** y llaman o escriben por WhatsApp. Cada taxista cambia su estado con su usuario y contraseña; la administración maneja taxistas y tarifas desde el Panel.

- `server.js`: servidor Node (Express) con la API y avisos en vivo.
- `public/`: la página.
- Base de datos: MongoDB Atlas.
- Publicación: Render (`render.yaml`).

## Variables de entorno

| Variable | Qué es |
|---|---|
| `MONGODB_URI` | Cadena de conexión de MongoDB Atlas (`mongodb+srv://...`). |
| `ADMIN_PASSWORD` | Clave para entrar al Panel de administración. |
| `JWT_SECRET` | Texto secreto largo para firmar las sesiones (Render lo genera solo). |
| `DB_NAME` | Opcional. Nombre de la base de datos (por defecto `taxis_los_jardines`). |

Nunca subas estos valores al repositorio.

## Probar en la computadora

```
npm install
set ADMIN_PASSWORD=una-clave
npm start
```

Sin `MONGODB_URI` los datos se guardan solo en memoria y se pierden al cerrar.

## Entrar al Panel

En la pestaña **Taxis** toca **Soy taxista** → **¿Eres de la administración? Entra aquí** y escribe la clave `ADMIN_PASSWORD`.
