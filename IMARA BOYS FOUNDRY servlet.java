package com.imaraboys;

import jakarta.servlet.ServletException;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

@WebServlet("/mentor")
public class MentorServlet extends HttpServlet {
    private static final long serialVersionUID = 1L;

    protected void doPost(HttpServletRequest request, HttpServletResponse response) 
            throws ServletException, IOException {
        
        // Ingest string items directly from HTML components mapping via names
        String name = request.getParameter("mentorName");
        String email = request.getParameter("mentorEmail");
        String phone = request.getParameter("mentorPhone");
        String skill = request.getParameter("mentorSkill");

        // ENGINEERING TIP: Insert your JDBC Database execution code blocks here!
        // Connection conn = DriverManager.getConnection("jdbc:mysql://localhost:3306/imara_db", "user", "pass");
        // PreparedStatement ps = conn.prepareStatement("INSERT INTO mentors VALUES (?,?,?,?)");
        
        System.out.println("Processing Database ingestion for Mentor: " + name + " | Skill: " + skill);

        // Feedback redirection script invocation loop
        response.setContentType("text/html");
        response.getWriter().println("<script>alert('Thank you " + name + ", your application has been captured in our backend system!'); window.location.href='index.html';</script>");
    }
}
