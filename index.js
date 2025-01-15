// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const morgan = require("morgan");
const { Client } = require("ssh2");
const fs = require("fs");
const cron = require("node-cron");
const { PassThrough } = require("stream");
const path = require("path");
const app = express();
const port = 3000;

// List of required environment variables
const requiredEnvVars = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "S3_BUCKET_NAME",
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "SSH_HOST",
  "SSH_USER",
  "SSH_PASSWORD",
];

// Check for missing environment variables
const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

// Middleware
app.use(express.json());
app.use(morgan("combined")); // Logging

// Serve static files (index.html)
app.use(express.static(path.join(__dirname, "public")));

// Endpoint to check environment variables
app.get("/env-check", (req, res) => {
  if (missingEnvVars.length > 0) {
    res.status(400).json({
      success: false,
      message: "Missing required environment variables",
      missing: missingEnvVars,
    });
  } else {
    res
      .status(200)
      .json({ success: true, message: "All environment variables are set" });
  }
});

// Configure AWS S3 client (only if all environment variables are set)
let s3Client;
if (missingEnvVars.length === 0) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

// Backup endpoint with SSH2 (only if all environment variables are set)
app.post("/backup", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  let backupFilePath = `./backup_${Date.now()}.sql.gz`;
  let fileStream = fs.createWriteStream(backupFilePath);

  try {
    const conn = new Client();

    // Connect to the remote server via SSH
    conn.on("ready", () => {
      console.log("SSH connection established.");

      // Run mysqldump on the remote server and stream the output
      conn.exec(
        `mysqldump -h ${process.env.DB_HOST} -u ${process.env.DB_USER} -p${process.env.DB_PASSWORD} ${process.env.DB_NAME} | gzip`,
        (err, stream) => {
          if (err) {
            console.error("Failed to execute mysqldump:", err);
            res.status(500).json({ error: "Failed to execute mysqldump" });
            conn.end();
            return;
          }

          // Stream the output to a local file
          stream.pipe(fileStream);

          stream.on("close", () => {
            console.log("Backup file created:", backupFilePath);
            conn.end();

            // Upload the backup file to S3 using streams
            const passThrough = new PassThrough();
            fs.createReadStream(backupFilePath).pipe(passThrough);

            const uploadParams = {
              Bucket: process.env.S3_BUCKET_NAME,
              Key: `backups/${backupFilePath.split("/").pop()}`,
              Body: passThrough,
            };

            s3Client
              .send(new PutObjectCommand(uploadParams))
              .then((data) => {
                console.log("Backup uploaded to S3:", data.Key);
                res.status(200).json({
                  message: "Backup successful",
                  key: uploadParams.Key,
                });
              })
              .catch((err) => {
                console.error("S3 upload error:", err);
                res.status(500).json({ error: "S3 upload failed" });
              });
          });

          stream.on("error", (err) => {
            console.error("Stream error:", err);
            res.status(500).json({ error: "Stream error during backup" });
            conn.end();
          });
        }
      );
    });

    conn.on("error", (err) => {
      console.error("SSH connection error:", err);
      res.status(500).json({ error: "SSH connection failed" });
    });

    conn.connect({
      host: process.env.SSH_HOST,
      port: 22,
      username: process.env.SSH_USER,
      password: process.env.SSH_PASSWORD,
    });
  } catch (error) {
    console.error("Backup error:", error);
    res.status(500).json({ error: "Backup failed" });
  } finally {
    // Ensure the file is deleted after upload or on error
    fileStream.close(() => {
      fs.unlink(backupFilePath, (err) => {
        if (err) console.error("Error deleting backup file:", err);
        else console.log("Backup file deleted:", backupFilePath);
      });
    });
  }
});

// Restore endpoint (only if all environment variables are set)
app.post("/restore/:key", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  const { key } = req.params;
  let restoreFilePath = `./restore_${Date.now()}.sql.gz`;

  try {
    // Download the backup file from S3
    const getObjectParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
    };

    const { Body: s3Stream } = await s3Client.send(
      new GetObjectCommand(getObjectParams)
    );
    const fileStream = fs.createWriteStream(restoreFilePath);
    s3Stream.pipe(fileStream);

    fileStream.on("finish", () => {
      console.log("Backup file downloaded:", restoreFilePath);

      // Run mysql command to restore the database
      const mysqlCommand = `gunzip < ${restoreFilePath} | mysql -h ${process.env.DB_HOST} -u ${process.env.DB_USER} -p${process.env.DB_PASSWORD} ${process.env.DB_NAME}`;
      exec(mysqlCommand, (error, stdout, stderr) => {
        if (error) {
          console.error("Restore error:", error);
          res.status(500).json({ error: "Restore failed" });
          return;
        }

        res.status(200).json({ message: "Restore successful" });
      });
    });

    fileStream.on("error", (err) => {
      console.error("File stream error:", err);
      res.status(500).json({ error: "Failed to download backup file" });
    });
  } catch (error) {
    console.error("Restore error:", error);
    res.status(500).json({ error: "Restore failed" });
  } finally {
    // Ensure the file is deleted after restore or on error
    fs.unlink(restoreFilePath, (err) => {
      if (err) console.error("Error deleting restore file:", err);
      else console.log("Restore file deleted:", restoreFilePath);
    });
  }
});

// List backups endpoint (only if all environment variables are set)
app.get("/backups", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  try {
    const listObjectsParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "backups/",
    };

    const data = await s3Client.send(
      new ListObjectsV2Command(listObjectsParams)
    );

    const backups = data.Contents.map((item) => ({
      key: item.Key,
      size: item.Size,
      lastModified: item.LastModified,
    }));

    res.status(200).json(backups);
  } catch (error) {
    console.error("List backups error:", error);
    res.status(500).json({ error: "Failed to list backups" });
  }
});

// Delete backup endpoint (only if all environment variables are set)
app.delete("/backups/:key", async (req, res) => {
  if (missingEnvVars.length > 0) {
    return res
      .status(400)
      .json({ error: "Missing required environment variables" });
  }

  try {
    const { key } = req.params;

    const deleteObjectParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
    };

    await s3Client.send(new DeleteObjectCommand(deleteObjectParams));
    res.status(200).json({ message: "Backup deleted successfully" });
  } catch (error) {
    console.error("Delete backup error:", error);
    res.status(500).json({ error: "Failed to delete backup" });
  }
});

// Retention policy: Delete backups older than 30 days (only if all environment variables are set)
const deleteOldBackups = async () => {
  if (missingEnvVars.length > 0) {
    console.error(
      "Cannot run retention policy: Missing required environment variables"
    );
    return;
  }

  try {
    const listObjectsParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "backups/",
    };

    const data = await s3Client.send(
      new ListObjectsV2Command(listObjectsParams)
    );

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

    for (const item of data.Contents) {
      if (item.LastModified < new Date(thirtyDaysAgo)) {
        const deleteObjectParams = {
          Bucket: process.env.S3_BUCKET_NAME,
          Key: item.Key,
        };

        await s3Client.send(new DeleteObjectCommand(deleteObjectParams));
        console.log(`Deleted old backup: ${item.Key}`);
      }
    }
  } catch (error) {
    console.error("Error deleting old backups:", error);
  }
};

// Schedule retention policy cleanup daily at 3 AM (only if all environment variables are set)
if (missingEnvVars.length === 0) {
  cron.schedule("0 3 * * *", deleteOldBackups);
}

// Schedule automated backups daily at 2 AM (only if all environment variables are set)
if (missingEnvVars.length === 0) {
  cron.schedule("0 2 * * *", async () => {
    try {
      console.log("Running scheduled backup...");
      const response = await axios.post("http://localhost:3000/backup");
      console.log("Scheduled backup successful:", response.data);
    } catch (error) {
      console.error(
        "Scheduled backup failed:",
        error.response ? error.response.data : error.message
      );
    }
  });
}

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
