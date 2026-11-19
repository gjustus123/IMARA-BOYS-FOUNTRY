package com.imaraboys;

import jakarta.servlet.ServletException;
import jakarta.servlet.annotation.MultipartConfig;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.Part;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Iterator;
import java.util.Locale;
import java.util.UUID;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;

@WebServlet("/mentor")
@MultipartConfig(maxFileSize = 5 * 1024 * 1024, maxRequestSize = 6 * 1024 * 1024)
public class MentorServlet extends HttpServlet {
    private static final long serialVersionUID = 1L;
    private static final long MAX_IMAGE_PIXELS = 16_000_000L;
    private static final int MAX_IMAGE_DIMENSION = 4096;

    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        String name = request.getParameter("mentorName");
        String email = request.getParameter("mentorEmail");
        String phone = request.getParameter("mentorPhone");
        String skill = request.getParameter("mentorSkill");
        Part profilePicture = request.getPart("profilePicture");

        if (profilePicture == null || profilePicture.getSize() == 0) {
            response.sendError(HttpServletResponse.SC_BAD_REQUEST, "A profile picture is required.");
            return;
        }
        if (profilePicture.getSize() > 5 * 1024 * 1024) {
            response.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, "The image must be 5 MB or smaller.");
            return;
        }

        String extension = getImageExtension(profilePicture);
        if (extension == null) {
            response.sendError(
                    HttpServletResponse.SC_UNSUPPORTED_MEDIA_TYPE,
                    "Upload a valid PNG or JPEG image no larger than 4096 pixels per side."
            );
            return;
        }

        Path uploadDirectory = Paths.get(
                System.getProperty("user.home"),
                "ImaraBoysFoundry",
                "uploads"
        ).toAbsolutePath().normalize();
        String storedFileName = UUID.randomUUID() + extension;
        Path destination = uploadDirectory.resolve(storedFileName);

        try {
            Files.createDirectories(uploadDirectory);
            try (InputStream input = profilePicture.getInputStream()) {
                Files.copy(input, destination);
            }
        } catch (IOException exception) {
            try {
                Files.deleteIfExists(destination);
            } catch (IOException cleanupException) {
                exception.addSuppressed(cleanupException);
            }
            getServletContext().log("Unable to save mentor profile picture.", exception);
            response.sendError(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "Unable to save the profile picture.");
            return;
        }

        System.out.println(
                "Received mentor application for " + name + " (" + email + ", " + phone + ")"
                        + " | Skill: " + skill
                        + " | Profile picture: " + destination
        );

        response.setContentType("text/html;charset=UTF-8");
        response.getWriter().println(
                "<!doctype html><html lang=\"en\"><body>"
                        + "<p>Thank you. Your mentor application and profile picture were received.</p>"
                        + "</body></html>"
        );
    }

    private String getImageExtension(Part part) throws IOException {
        try (InputStream input = part.getInputStream();
                ImageInputStream imageInput = ImageIO.createImageInputStream(input)) {
            if (imageInput == null) {
                return null;
            }

            Iterator<ImageReader> readers = ImageIO.getImageReaders(imageInput);
            if (!readers.hasNext()) {
                return null;
            }

            ImageReader reader = readers.next();
            try {
                reader.setInput(imageInput, true, true);
                String format = reader.getFormatName().toLowerCase(Locale.ROOT);
                if (!"png".equals(format) && !"jpeg".equals(format) && !"jpg".equals(format)) {
                    return null;
                }

                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                if (width <= 0
                        || height <= 0
                        || width > MAX_IMAGE_DIMENSION
                        || height > MAX_IMAGE_DIMENSION
                        || (long) width * height > MAX_IMAGE_PIXELS) {
                    return null;
                }

                BufferedImage decodedImage = reader.read(0);
                if (decodedImage == null) {
                    return null;
                }
                return "png".equals(format) ? ".png" : ".jpg";
            } finally {
                reader.dispose();
            }
        }
    }
}
