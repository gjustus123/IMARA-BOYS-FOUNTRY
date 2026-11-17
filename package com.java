package com.imaraboys;

import jakarta.servlet.ServletException;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

@WebServlet("/donate")
public class DonateServlet extends HttpServlet {
    private static final long serialVersionUID = 1L;

    protected void doPost(HttpServletRequest request, HttpServletResponse response) 
            throws ServletException, IOException {
        
        // 1. Grab raw parameter variables from the HTML DOM
        String amount = request.getParameter("amount");
        String phone = request.getParameter("phone");

        // Format Kenyan Phone Format safely (Convert 07... to 2547...)
        if (phone != null && phone.startsWith("0")) {
            phone = "254" + phone.substring(1);
        }

        // 2. Daraja Sandbox Configurations Credentials
        String consumerKey = "YOUR_DARJA_CONSUMER_KEY";
        String consumerSecret = "YOUR_DARAJA_CONSUMER_SECRET";
        String shortcode = "174379"; // Lipa Na M-Pesa Test Till
        String passkey = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
        
        // Generate ISO Timestamp format (YYYYMMDDHHmmss)
        String timestamp = java.time.format.DateTimeFormatter.ofPattern("yyyyMMddHHmmss")
                            .format(java.time.LocalDateTime.now());
        
        // Cryptographic Base64 Signature Password creation
        String passwordStr = shortcode + passkey + timestamp;
        String password = Base64.getEncoder().encodeToString(passwordStr.getBytes(StandardCharsets.UTF_8));

        try {
            // 3. Connect to Safaricom OAuth Gateway to fetch Access Token
            String credentials = consumerKey + ":" + consumerSecret;
            String authHeader = "Basic " + Base64.getEncoder().encodeToString(credentials.getBytes());
            
            URL authUrl = new URL("https://safaricom.co.ke");
            HttpURLConnection authConn = (HttpURLConnection) authUrl.openConnection();
            authConn.setRequestMethod("GET");
            authConn.setRequestProperty("Authorization", authHeader);
            
            // In a production app, use a JSON parser (like Jackson/Gson) to extract access_token string
            // For this project example, we bypass token checking to demonstrate downstream payload execution
            String accessToken = "DUMMY_TOKEN_FETCHED_FROM_RESPONSE";

            // 4. Construct JSON Payload data using standard text mapping
            String stkPayload = "{"
                + "\"BusinessShortCode\":\"" + shortcode + "\","
                + "\"Password\":\"" + password + "\","
                + "\"Timestamp\":\"" + timestamp + "\","
                + "\"TransactionType\":\"CustomerPayBillOnline\","
                + "\"Amount\":\"" + amount + "\","
                + "\"PartyA\":\"" + phone + "\","
                + "\"PartyB\":\"" + shortcode + "\","
                + "\"PhoneNumber\":\"" + phone + "\","
                + "\"CallBackURL\":\"https://yourdomain.com\","
                + "\"AccountReference\":\"ImaraBoysFoundry\","
                + "\"TransactionDesc\":\"Sponsorship Contribution\""
                + "}";

            // 5. Fire STK Push Request to Safaricom API Endpoints
            URL mpesaUrl = new URL("https://safaricom.co.ke");
            HttpURLConnection conn = (HttpURLConnection) mpesaUrl.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);

            try (OutputStream os = conn.getOutputStream()) {
                byte[] input = stkPayload.getBytes(StandardCharsets.UTF_8);
                os.write(input, 0, input.length);
            }

            // Redirect back to landing page showing success alert simulation
            response.setContentType("text/html");
            response.getWriter().println("<script>alert('M-Pesa STK Push initiated successfully to " + phone + "!'); window.location.href='index.html';</script>");

        } catch (Exception e) {
            response.getWriter().println("Error processing API execution: " + e.getMessage());
        }
    }
}
